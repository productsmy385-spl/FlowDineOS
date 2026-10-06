import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * ZIP writer and reader for restaurant backups (RASOIOS-ADR-021).
 *
 * Written out rather than taken from a dependency, like the print agent's packager (print-agent/packaging/archive.mjs):
 * the format is small and fixed. Deliberately minimal — no ZIP64, no encryption, no directory entries — which is all a
 * backup of a restaurant's records needs.
 *
 * The reader takes untrusted uploads, so it is defensive: it reads only the central directory, refuses encrypted or
 * unknown compression, caps the entry count and the total inflated size (zip-bomb guard), and rejects any entry name
 * that is not a plain relative path.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export type ZipEntry = { name: string; data: Buffer };

export function zip(files: readonly ZipEntry[], at: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export class ZipError extends Error {}

export type UnzipLimits = { maxEntries: number; maxTotalBytes: number };

/** Reads every entry of an archive. Throws `ZipError` with a message a restaurant admin can act on. */
export function unzip(buf: Buffer, limits: UnzipLimits): ZipEntry[] {
  // The end-of-central-directory record is the last 22 bytes plus an optional comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("This is not a ZIP file.");

  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (count > limits.maxEntries) throw new ZipError(`The ZIP holds ${count} files; a backup has at most ${limits.maxEntries}.`);

  const entries: ZipEntry[] = [];
  let total = 0;
  let p = centralOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("The ZIP file is damaged.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    p += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue; // directory entry written by another tool
    if (flags & 0x1) throw new ZipError("Password-protected ZIP files cannot be imported.");
    if (method !== 0 && method !== 8) throw new ZipError("The ZIP uses a compression method that is not supported.");
    // Plain relative names only; square brackets are allowed for Excel's own "[Content_Types].xml".
    if (!/^[\w[][\w .\-/[\]]*$/.test(name) || name.includes("..")) throw new ZipError(`The ZIP contains an unexpected file name: ${name.slice(0, 80)}`);

    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError("The backup is too large to import in one go.");

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError("The ZIP file is damaged.");
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    try {
      data = method === 8 ? inflateRawSync(raw, { maxOutputLength: size + 1 }) : Buffer.from(raw);
    } catch {
      throw new ZipError("The ZIP file is damaged.");
    }
    if (data.length !== size) throw new ZipError("The ZIP file is damaged.");
    entries.push({ name, data });
  }
  return entries;
}

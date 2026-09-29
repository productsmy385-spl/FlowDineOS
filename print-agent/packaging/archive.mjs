/**
 * ZIP and tar.gz writers for the print agent release packages (S1-P17-T009).
 *
 * Written out rather than taken from a dependency: both formats are small, fixed and fully specified, the agent
 * package is the one thing we build with them, and a restaurant downloads an installer that runs as Administrator —
 * so the fewer third-party bytes between our source and that file, the better. Node's zlib does the compression.
 *
 * Deliberately minimal: no directory entries, no ZIP64, no symlinks, no unicode path extras. Every name we write is
 * ASCII and every file is far below 4 GB, which is what those extensions exist for.
 */
import { deflateRawSync, gzipSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * MS-DOS date/time, the only timestamp a ZIP local header carries. Fixed to a constant so two builds of identical
 * bytes produce an identical archive — a reproducible package is one a restaurant can checksum against ours.
 */
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

/**
 * @param {{name: string, data: Buffer, executable?: boolean}[]} files
 * @returns {Buffer} a ZIP archive, deflate-compressed
 */
export function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "ascii");
    const compressed = deflateRawSync(file.data, { level: 9 });
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory header
    header.writeUInt16LE(0x031e, 4); // made by: UNIX, 3.0 — so the mode below is honoured
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(file.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    // External attrs: high 16 bits are the UNIX mode. Windows ignores it; an unzip on Linux keeps the +x bit.
    header.writeUInt32LE(((file.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}

/** One 512-byte ustar header. Numeric fields are octal, NUL-terminated, as the format requires. */
function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512);
  const put = (value, offset, length) => header.write(value.padEnd(length, "\0"), offset, "ascii");
  const octal = (value, offset, length) => put(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);

  put(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(size, 124, 12);
  octal(0, 136, 12); // mtime 0, for the same reproducibility reason as the ZIP date
  header.write("        ", 148, 8, "ascii"); // checksum field is spaces while it is computed
  put("0", 156, 1); // type: regular file
  put("ustar\0", 257, 6);
  put("00", 263, 2);

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

/**
 * @param {{name: string, data: Buffer, executable?: boolean}[]} files
 * @returns {Buffer} a gzip-compressed tar archive
 */
export function tarGz(files) {
  const parts = [];
  for (const file of files) {
    parts.push(tarHeader(file.name, file.data.length, file.executable ? 0o755 : 0o644), file.data);
    const padding = (512 - (file.data.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024)); // two empty blocks terminate a tar
  return gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
}

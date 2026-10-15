import sharp from "sharp";
import fs from "fs";
import path from "path";

const SOURCE_IMAGE = "C:/Users/Gopala Krishna/.gemini/antigravity-ide/brain/4b8feaac-4f43-4462-ab4c-68d5a02d42e9/.user_uploaded/media_1792047165921.png";
const KRANAS_LOGO_IMAGE = "C:/Users/Gopala Krishna/.gemini/antigravity-ide/brain/4b8feaac-4f43-4462-ab4c-68d5a02d42e9/.user_uploaded/media_1792047391767.png";

const ROOT_DIR = path.resolve(".");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const APP_DIR = path.join(ROOT_DIR, "app");

function createIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type 1
  header.writeUInt16LE(count, 4); // count

  const dirEntries = [];
  for (const item of pngBuffers) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(item.width >= 256 ? 0 : item.width, 0);
    entry.writeUInt8(item.height >= 256 ? 0 : item.height, 1);
    entry.writeUInt8(0, 2); // color palette (0)
    entry.writeUInt8(0, 3); // reserved (0)
    entry.writeUInt16LE(1, 4); // color planes (1)
    entry.writeUInt16LE(32, 6); // bits per pixel (32)
    entry.writeUInt32LE(item.buffer.length, 8); // size
    entry.writeUInt32LE(offset, 12); // offset
    dirEntries.push(entry);
    offset += item.buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map((b) => b.buffer)]);
}

async function generate() {
  console.log("Generating FlowDineOS brand and icon assets from transparent source...");
  if (!fs.existsSync(SOURCE_IMAGE)) {
    throw new Error(`Source image not found: ${SOURCE_IMAGE}`);
  }

  // The source image is already transparent 1024x1024. Trim transparent border slightly if needed or keep full:
  // Using trim() with transparent background ensures tight bounding box, then resize to clean square.
  const trimmed = sharp(SOURCE_IMAGE).trim();
  const trimmedBuffer = await trimmed.toBuffer();
  
  // Fit into square with transparent background
  const squareBuffer = await sharp(trimmedBuffer)
    .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ quality: 100 })
    .toBuffer();

  // 1. Full uncropped original copy in public/
  await sharp(SOURCE_IMAGE)
    .png({ quality: 100 })
    .toFile(path.join(PUBLIC_DIR, "logo-original.png"));
  console.log("Created public/logo-original.png");

  // 2. High-res logo (512x512)
  const logo512 = await sharp(squareBuffer)
    .resize(512, 512, { kernel: sharp.kernel.lanczos3, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ quality: 100 })
    .toBuffer();

  await fs.promises.writeFile(path.join(PUBLIC_DIR, "logo.png"), logo512);
  await fs.promises.writeFile(path.join(PUBLIC_DIR, "logo-mark.png"), logo512);
  console.log("Created public/logo.png and public/logo-mark.png (512x512, transparent)");

  // 3. PWA manifest icons: icon-192.png and icon-512.png
  const icon192 = await sharp(squareBuffer)
    .resize(192, 192, { kernel: sharp.kernel.lanczos3, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ quality: 100 })
    .toBuffer();

  await fs.promises.writeFile(path.join(PUBLIC_DIR, "icon-192.png"), icon192);
  await fs.promises.writeFile(path.join(PUBLIC_DIR, "icon-512.png"), logo512);
  console.log("Created public/icon-192.png and public/icon-512.png");

  // 4. Apple Touch Icon (180x180)
  const appleIcon = await sharp(squareBuffer)
    .resize(180, 180, { kernel: sharp.kernel.lanczos3, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ quality: 100 })
    .toBuffer();

  await fs.promises.writeFile(path.join(PUBLIC_DIR, "apple-icon.png"), appleIcon);
  await fs.promises.writeFile(path.join(PUBLIC_DIR, "apple-touch-icon.png"), appleIcon);
  await fs.promises.writeFile(path.join(APP_DIR, "apple-icon.png"), appleIcon);
  console.log("Created apple-icon.png (180x180) in public/ and app/");

  // 5. Standard icon.png (64x64)
  const icon64 = await sharp(squareBuffer)
    .resize(64, 64, { kernel: sharp.kernel.lanczos3, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ quality: 100 })
    .toBuffer();

  await fs.promises.writeFile(path.join(PUBLIC_DIR, "icon.png"), icon64);
  await fs.promises.writeFile(path.join(APP_DIR, "icon.png"), icon64);
  console.log("Created icon.png (64x64) in public/ and app/");

  // 6. Multi-resolution favicon.ico (16x16, 32x32, 48x48)
  const icon16 = await sharp(squareBuffer)
    .resize(16, 16, { kernel: sharp.kernel.lanczos3, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const icon32 = await sharp(squareBuffer)
    .resize(32, 32, { kernel: sharp.kernel.lanczos3, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const icon48 = await sharp(squareBuffer)
    .resize(48, 48, { kernel: sharp.kernel.lanczos3, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const icoBuffer = createIco([
    { width: 16, height: 16, buffer: icon16 },
    { width: 32, height: 32, buffer: icon32 },
    { width: 48, height: 48, buffer: icon48 },
  ]);

  await fs.promises.writeFile(path.join(PUBLIC_DIR, "favicon.ico"), icoBuffer);
  await fs.promises.writeFile(path.join(APP_DIR, "favicon.ico"), icoBuffer);
  console.log("Created favicon.ico in public/ and app/");

  // 7. KRANAS TECH & SOLUTIONS PVT LTD logo in public/
  if (fs.existsSync(KRANAS_LOGO_IMAGE)) {
    const kranasLogo = await sharp(KRANAS_LOGO_IMAGE)
      .trim()
      .png({ quality: 100 })
      .toBuffer();
    await fs.promises.writeFile(path.join(PUBLIC_DIR, "kranas-logo.png"), kranasLogo);
    console.log("Created public/kranas-logo.png");
  }

  console.log("All brand, favicon, and company assets successfully generated!");
}

generate().catch((err) => {
  console.error("Asset generation error:", err);
  process.exit(1);
});

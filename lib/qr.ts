import qrcode from "qrcode-generator";

/**
 * QR codes for table menus (RASOIOS-ADR-021), drawn by `qrcode-generator` (MIT, no dependencies).
 *
 * Always dark modules on white with a four-module quiet zone: a themed or low-contrast code scans badly on a phone in a
 * dim restaurant, so the code itself is never branded. Error correction M survives a table-tent crease or a smudge.
 */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

/** The code as one SVG path over a square of `size` modules (quiet zone included), for rendering as React elements. */
export function qrPath(text: string): { size: number; d: string } {
  const matrix = qrMatrix(text);
  const margin = 4;
  let d = "";
  matrix.forEach((cells, y) => cells.forEach((dark, x) => dark && (d += `M${x + margin} ${y + margin}h1v1h-1z`)));
  return { size: matrix.length + margin * 2, d };
}

/** A scalable SVG (viewBox only) of the code, as a file — for download and printing, never injected into the page. */
export function qrSvg(text: string, title: string): string {
  const { size, d } = qrPath(text);
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${safeTitle}"><title>${safeTitle}</title><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}

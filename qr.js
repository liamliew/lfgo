// QR rendering on top of the vendored `uqr` encoder (vendor/uqr.mjs, MIT).
// Colours are fixed black on white on purpose: scanners need the contrast
// regardless of the page theme.
import { encode } from "./vendor/uqr.mjs";

const DARK = "#000000";
const LIGHT = "#ffffff";
export const QUIET_ZONE = 4; // modules of white border, per the QR spec

/** Boolean module matrix for `text`. Medium error correction. */
export function qrMatrix(text) {
  return encode(text, { ecc: "M", border: 0 }).data;
}

/** A standalone SVG document string (one <path>, crisp at any size). */
export function qrSvg(text, { margin = QUIET_ZONE } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  let d = "";
  for (let y = 0; y < m.length; y++) {
    let x = 0;
    while (x < m.length) {
      if (!m[y][x]) { x++; continue; }
      const start = x;
      while (x < m.length && m[y][x]) x++;
      d += `M${start + margin} ${y + margin}h${x - start}v1h-${x - start}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * 8}" height="${n * 8}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="${LIGHT}"/><path d="${d}" fill="${DARK}"/></svg>`
  );
}

/**
 * Draw the code on a canvas. The pixel size is rounded to a whole number of
 * pixels per module so edges stay sharp: down by default (fits `targetPx`),
 * up with `atLeast` (never smaller than `targetPx`).
 */
export function drawQr(canvas, text, targetPx, { margin = QUIET_ZONE, atLeast = false } = {}) {
  const m = qrMatrix(text);
  const modules = m.length + margin * 2;
  const scale = Math.max(1, (atLeast ? Math.ceil : Math.floor)(targetPx / modules));
  const px = modules * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = LIGHT;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = DARK;
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (m[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
  }
  return px;
}

/** PNG of the code, at least `minPx` wide, as a Blob. */
export function qrPngBlob(text, minPx = 1024) {
  const canvas = document.createElement("canvas");
  drawQr(canvas, text, minPx, { atLeast: true });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png"),
  );
}

export const qrSvgBlob = (text) => new Blob([qrSvg(text)], { type: "image/svg+xml" });

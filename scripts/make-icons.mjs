/**
 * Generates the site favicon / app icons from a vector description of the
 * Pumpkin Patches Near Me pumpkin mark. Pure Node (zlib only), no image deps.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/assets/img');

const COLORS = {
  bg: [255, 255, 255, 0],
  body: [242, 106, 33, 255],
  bodyLight: [255, 138, 61, 255],
  rib: [199, 74, 15, 255],
  edge: [166, 58, 8, 255],
  stem: [63, 122, 46, 255],
  stemEdge: [45, 89, 33, 255],
};

/* ------------------------------------------------------------------ shapes */

// Normalised ellipse "distance": < 1 inside, 1 on the edge.
const ell = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;

const LOBES = [
  { cx: 0.5, rx: 0.205, ry: 0.315 },
  { cx: 0.5 - 0.15, rx: 0.185, ry: 0.3 },
  { cx: 0.5 + 0.15, rx: 0.185, ry: 0.3 },
  { cx: 0.5 - 0.275, rx: 0.14, ry: 0.245 },
  { cx: 0.5 + 0.275, rx: 0.14, ry: 0.245 },
];
const BODY_CY = 0.63;

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
  255,
];

// Curved stem: a leaning capsule capped with a rounded top.
function stemDist(x, y) {
  const lean = (0.36 - y) * 0.55;
  const dx = Math.abs(x - (0.5 + lean));
  if (y >= 0.22 && y <= 0.4) return dx;
  if (y < 0.22) return Math.hypot(x - (0.5 + (0.36 - 0.22) * 0.55), y - 0.22);
  return Infinity;
}

function shade(x, y) {
  const sd = stemDist(x, y);
  if (sd < 0.056) return sd > 0.042 ? COLORS.stemEdge : COLORS.stem;

  let inside = false;
  for (const l of LOBES) {
    if (ell(x, y, l.cx, BODY_CY, l.rx, l.ry) <= 1) inside = true;
  }
  if (!inside) return null;

  // Outer silhouette stroke: near a boundary but outside every other lobe.
  const nearAnyEdge = LOBES.some((l) => Math.abs(ell(x, y, l.cx, BODY_CY, l.rx, l.ry) - 1) < 0.075);
  if (nearAnyEdge && LOBES.every((l) => ell(x, y, l.cx, BODY_CY, l.rx, l.ry) > 0.96)) {
    return COLORS.edge;
  }

  // Ribs: the near-vertical flanks of the inner lobes only, so the ellipse
  // caps do not read as full ovals drawn across the pumpkin.
  for (const l of LOBES.slice(1)) {
    const d = ell(x, y, l.cx, BODY_CY, l.rx, l.ry);
    if (Math.abs(d - 1) < 0.055 && Math.abs(x - l.cx) > l.rx * 0.45) return COLORS.rib;
  }

  // Soft highlight on the upper-left shoulder.
  const h = ell(x, y, 0.395, 0.52, 0.155, 0.185);
  if (h < 1) return mix(COLORS.bodyLight, COLORS.body, Math.min(1, h ** 0.7));
  return COLORS.body;
}

/* -------------------------------------------------------------- rasteriser */

function render(size) {
  const SS = 4; // supersampling factor
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxi + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = shade(x, y) || COLORS.bg;
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
          n++;
        }
      }
      const i = (py * size + pxi) * 4;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

/* ------------------------------------------------------------- PNG encoder */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container holding PNG-encoded entries (supported by every modern browser). */
function toIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dir.push(d);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

/* -------------------------------------------------------------------- main */

mkdirSync(OUT, { recursive: true });

const sizes = [16, 32, 48, 180, 192, 512];
const pngs = new Map();
for (const s of sizes) pngs.set(s, toPng(s, render(s)));

writeFileSync(resolve(OUT, 'favicon-16.png'), pngs.get(16));
writeFileSync(resolve(OUT, 'favicon-32.png'), pngs.get(32));
writeFileSync(resolve(OUT, 'apple-touch-icon.png'), pngs.get(180));
writeFileSync(resolve(OUT, 'icon-192.png'), pngs.get(192));
writeFileSync(resolve(OUT, 'icon-512.png'), pngs.get(512));
writeFileSync(
  resolve(ROOT, 'src/assets/img/favicon.ico'),
  toIco([16, 32, 48].map((size) => ({ size, png: pngs.get(size) })))
);

/* ------------------------------------------------- social sharing artwork */

function renderOg(w, h) {
  const SS = 3;
  const px = Buffer.alloc(w * h * 4);
  const cream = [255, 244, 235];
  const band = [242, 106, 33];
  // The pumpkin is drawn into a square viewport centred in the canvas.
  const box = h * 0.72;
  const ox = (w - box) / 2;
  const oy = (h - box) / 2 - h * 0.03;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          let c;
          const inBand = fy > h - 46 || fy < 46 || fx < 46 || fx > w - 46;
          c = inBand ? band : cream;
          const u = (fx - ox) / box;
          const v = (fy - oy) / box;
          if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
            const s = shade(u, v);
            if (s) c = s;
          }
          r += c[0]; g += c[1]; b += c[2]; n++;
        }
      }
      const i = (y * w + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = 255;
    }
  }
  return px;
}

const OG_W = 1200;
const OG_H = 630;
// toPng assumes a square; write the OG frame with an inline non-square encode.
function toPngRect(w, h, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    pixels.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
writeFileSync(resolve(OUT, 'og-image.png'), toPngRect(OG_W, OG_H, renderOg(OG_W, OG_H)));

console.log('Icons written to src/assets/img/');

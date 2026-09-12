// Draws the K9 app icon (green rounded square with a white "K9") without any
// image tooling, and writes:
//   build-resources/icon.png  512×512 (electron-builder)
//   build-resources/icon.ico  256×256 PNG-in-ICO (exe, installer, shortcuts)
//   electron/assets/icon.png  256×256 (window, tray, splash)
//
//   node desktop/scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Geometry lives in a 512×512 design space.
const clamp01 = (n) => Math.min(1, Math.max(0, n));

function insideRoundedRect(u, v, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function distanceToSegment(u, v, ax, ay, bx, by) {
  const t = clamp01(((u - ax) * (bx - ax) + (v - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2));
  return Math.hypot(u - (ax + t * (bx - ax)), v - (ay + t * (by - ay)));
}

const TOP = 132;
const BOTTOM = 380;

function insideGlyph(u, v) {
  if (v < TOP || v > BOTTOM) return false;
  // K
  if (u >= 90 && u <= 150) return true;
  if (distanceToSegment(u, v, 150, 262, 252, TOP) <= 28) return true;
  if (distanceToSegment(u, v, 170, 238, 266, BOTTOM) <= 28) return true;
  // 9: ring + right-hand stem
  const r = Math.hypot(u - 340, v - 214);
  if (r >= 38 && r <= 82) return true;
  return u >= 380 && u <= 422 && v >= 214;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4;
  const scale = 512 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let shape = 0;
      let glyph = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) * scale;
          const v = (y + (sy + 0.5) / samples) * scale;
          if (insideRoundedRect(u, v, 24, 24, 488, 488, 104)) {
            shape++;
            if (insideGlyph(u, v)) glyph++;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (shape === 0) continue;
      // Brand green #00A86B fading to a deeper green toward the bottom-right.
      const t = (x + y) / (2 * size);
      const bg = [0, Math.round(0xb8 - t * 0x38), Math.round(0x74 - t * 0x22)];
      const white = glyph / shape;
      rgba[i] = Math.round(bg[0] + (255 - bg[0]) * white);
      rgba[i + 1] = Math.round(bg[1] + (255 - bg[1]) * white);
      rgba[i + 2] = Math.round(bg[2] + (255 - bg[2]) * white);
      rgba[i + 3] = Math.round((shape / (samples * samples)) * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size) {
  const rgba = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // 256 px wide
  entry.writeUInt8(0, 1); // 256 px tall
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // image data offset
  return Buffer.concat([header, entry, png]);
}

export function writeIcons() {
  const buildResources = path.join(DESKTOP, "build-resources");
  const assets = path.join(DESKTOP, "electron", "assets");
  mkdirSync(buildResources, { recursive: true });
  mkdirSync(assets, { recursive: true });
  const png256 = encodePng(256);
  writeFileSync(path.join(buildResources, "icon.png"), encodePng(512));
  writeFileSync(path.join(buildResources, "icon.ico"), encodeIco(png256));
  writeFileSync(path.join(assets, "icon.png"), png256);
  console.log("[k9-build] icons written to build-resources/ and electron/assets/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeIcons();
}

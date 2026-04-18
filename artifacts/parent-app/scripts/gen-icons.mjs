// Generate PWA icons from a single brand SVG.
// Run with `pnpm run icons`. Outputs:
//   public/icon-192.png         (any)
//   public/icon-512.png         (any)
//   public/icon-maskable-512.png (maskable: 80% safe zone, full-bleed bg)
//   public/apple-touch-icon.png  (iOS Home Screen, 180x180)
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "public");

const GREEN = "#00A86B";
const NAVY = "#1A1A2E";

// Edge-to-edge tile (used for "any" purpose). Letter occupies ~55% of the
// canvas — looks balanced as a Home Screen icon.
function tileSvg(size) {
  const r = Math.round(size * 0.22);
  const fontSize = Math.round(size * 0.55);
  const cy = Math.round(size * 0.5 + fontSize * 0.34);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${GREEN}"/>
        <stop offset="100%" stop-color="#008A57"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
    <text x="50%" y="${cy}" text-anchor="middle"
      font-family="Inter, system-ui, sans-serif"
      font-weight="800" font-size="${fontSize}" fill="white">K</text>
  </svg>`;
}

// Maskable variant: full-bleed solid bg, letter fits inside the 80% safe area
// (Android may crop the outer 10% on each edge).
function maskableSvg(size) {
  const fontSize = Math.round(size * 0.42);
  const cy = Math.round(size * 0.5 + fontSize * 0.34);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${GREEN}"/>
    <text x="50%" y="${cy}" text-anchor="middle"
      font-family="Inter, system-ui, sans-serif"
      font-weight="800" font-size="${fontSize}" fill="white">K</text>
  </svg>`;
}

async function render(svgString, file) {
  await sharp(Buffer.from(svgString)).png().toFile(resolve(out, file));
  console.log("wrote", file);
}

await render(tileSvg(192), "icon-192.png");
await render(tileSvg(512), "icon-512.png");
await render(maskableSvg(512), "icon-maskable-512.png");
await render(tileSvg(180), "apple-touch-icon.png");

// Replace the (off-brand red) favicon with the green tile.
writeFileSync(resolve(out, "favicon.svg"), tileSvg(180));
console.log("wrote favicon.svg");
console.log("Brand colors:", { GREEN, NAVY });

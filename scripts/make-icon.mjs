// Rasterize build/icon.svg into a multi-resolution Windows .ico plus PNGs.
// Run: node scripts/make-icon.mjs
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(path.join(root, "build", "icon.svg"), "utf8");

const render = (size) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

mkdirSync(path.join(root, "build"), { recursive: true });

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map(render);

writeFileSync(path.join(root, "build", "icon.png"), render(512)); // electron-builder fallback / docs
writeFileSync(path.join(root, "public", "icon.png"), render(256)); // bundled window icon
writeFileSync(path.join(root, "build", "icon.ico"), await pngToIco(pngs));

console.log(`icon.ico (${icoSizes.join(",")}) + icon.png (512) + public/icon.png (256) geschreven`);

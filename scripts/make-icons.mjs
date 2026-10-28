// Regenerate the Windows/Linux icon set from the flat design source
// (build/icon-flat.svg — the owner's Affinity export, rounded squircle
// with baked transparency, owner ruling 2026-10-13).
//
//   build/icon.ico  — Windows (.ico with 16/24/32/48/64/128/256 PNG entries)
//   build/icon.png  — Linux (512×512; AppImage/deb/desktop entry)
//   public/pwa/*    — the web app manifest's icons (LH-46: 192, 512, maskable 512)
//   app/apple-icon.png — iOS home-screen icon (180×180)
//
// macOS does NOT come from here: build/icon.icon (the Icon Composer
// document) is the mac source of truth, compiled by actool at package
// time into Assets.car (macOS 26 Liquid Glass) + a fallback icns; the
// hand-packed build/icon.icns replaces that fallback's 256px cap via
// scripts/after-pack.cjs (pre-Tahoe keeps full-res).
//
// Renders each size DIRECTLY from the SVG (resvg) — sharper squircle
// edges than downsampling a raster. Committed outputs; rerun only when
// the design changes: `node scripts/make-icons.mjs`.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(path.join(root, "build", "icon-flat.svg"), "utf8");

const render = (size, source = svg) => new Resvg(source, { fitTo: { mode: "width", value: size } }).render(size, size).asPng();

// ---- build/icon.ico: ICONDIR + PNG entries ------------------------------
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = ICO_SIZES.map((size) => render(size));
// Header (6) + one 16-byte directory entry per image, then the PNGs.
const header = Buffer.alloc(6 + ICO_SIZES.length * 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(ICO_SIZES.length, 4);
let offset = header.length;
ICO_SIZES.forEach((size, i) => {
	const e = 6 + i * 16;
	header.writeUInt8(size === 256 ? 0 : size, e); // 0 encodes 256
	header.writeUInt8(size === 256 ? 0 : size, e + 1);
	header.writeUInt8(0, e + 2); // colors
	header.writeUInt8(0, e + 3); // reserved
	header.writeUInt16LE(1, e + 4); // planes
	header.writeUInt16LE(32, e + 6); // bpp
	header.writeUInt32LE(pngs[i].length, e + 8);
	header.writeUInt32LE(offset, e + 12);
	offset += pngs[i].length;
});
const ico = Buffer.concat([header, ...pngs]);
writeFileSync(path.join(root, "build", "icon.ico"), ico);
console.log(`build/icon.ico  ${ICO_SIZES.join("/")} — ${(ico.length / 1024).toFixed(1)} KB`);

// ---- build/icon.png: the Linux icon -------------------------------------
const png512 = render(512);
writeFileSync(path.join(root, "build", "icon.png"), png512);
console.log(`build/icon.png  512×512 — ${(png512.length / 1024).toFixed(1)} KB`);

// ---- PWA + iOS home-screen icons (LH-46) --------------------------------
// The launcher masks these itself: Android crops maskable icons to its own
// shape and iOS rounds the touch icon, filling transparent corners black.
// So both get a full-bleed #141414 square under the squircle; the maskable
// one also shrinks the glyph to 0.8 so it sits inside the 40%-radius safe
// zone (the glyph reaches 492 of 1024 from the centre, 394 after scaling).
const svgTag = svg.match(/<svg[^>]*>/)[0];
const fullBleed = svg.replace(svgTag, `${svgTag}<rect width="1024" height="1024" style="fill:rgb(20,20,20);"/>`);
const [squircle] = svg.match(/<path [^>]*fill:rgb\(20,20,20\);"\/>/);
const maskable = fullBleed.replace(squircle, "").replace("<g ", '<g transform="matrix(0.8,0,0,0.8,102.4,102.4)"><g ').replace("</svg>", "</g></svg>");
const outputs = [
	["public/pwa/icon-192.png", render(192)],
	["public/pwa/icon-512.png", png512],
	["public/pwa/icon-maskable-512.png", render(512, maskable)],
	["app/apple-icon.png", render(180, fullBleed)],
];
mkdirSync(path.join(root, "public", "pwa"), { recursive: true });
for (const [file, png] of outputs) {
	writeFileSync(path.join(root, file), png);
	console.log(`${file}  ${(png.length / 1024).toFixed(1)} KB`);
}

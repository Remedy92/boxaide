/**
 * Generates every app-icon file from one description, in pure Node.
 *
 *   node scripts/make-icons.mjs
 *
 * The mark and its material live in lib/mark.mjs; the renderer lives in
 * lib/icon-engine.mjs. This file only decides which files come out and at what
 * size, so adding a target never means restating the geometry.
 *
 * Writes, into build/:
 *   icon.icns            macOS bundle icon, on Apple's 824-of-1024 grid
 *   icon.ico             Windows, edge to edge
 *   icon.png             Linux and electron-builder's base, edge to edge
 *   icon-dock.png        the dev dock on macOS, which needs the mac inset
 *   icon.svg             the vector the web surfaces derive from
 *   trayTemplate.png     menu bar, 16pt, black plus alpha
 *   trayTemplate@2x.png  menu bar, retina
 *
 * And one file outside build/: apps/web/public/favicon.svg, written here so the
 * browser mark cannot drift from the app icon.
 *
 * electron-builder picks the first three up from buildResources by name.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAC_INSET, raster, toPng } from "./lib/icon-engine.mjs";
import {
  CHAMFER,
  MARK_EXTENT,
  iconShader,
  markPaths,
  sdMark,
  squirclePath,
} from "./lib/mark.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, "..", "build");

/** Anti-aliasing costs the most where it matters least. Big art needs less. */
const samples = (size) => (size >= 512 ? 2 : size >= 128 ? 3 : 4);

const FULL_BLEED = 0;

/* ---------------------------------------------------------------------------
   Menu bar.

   A template image is pure black plus alpha — the system recolours it for light
   and dark menu bars and for selection — so none of the plate's material
   survives the trip. What goes up there is the mark alone, as a silhouette,
   fitted to the bar rather than floating on a plate.

   It is also drawn slightly heavier than the engraved version, because at 16pt
   the mark is about 14px across and the icon's own stroke weight rasterises to
   grey fuzz. Only slightly, though: this shape is mostly counters — the gap
   inside each brace, the air around the dash — and weight closes them. Compared
   at 1.0, 1.15, 1.3 and 1.5 upscaled, everything from 1.3 up fills in and turns
   into a solid block.
   --------------------------------------------------------------------------- */
const TRAY_WEIGHT = 1.15;

function renderTray(size) {
  const margin = size / 16;
  const scale = (size - margin * 2) / (MARK_EXTENT.x * 2);
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  const step = 1 / ss;
  const off = step / 2;
  const total = ss * ss;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + sx * step + off - size / 2) / scale;
          const y = (py + sy * step + off - size / 2) / scale;
          if (sdMark(x, y, TRAY_WEIGHT) <= 0) hits++;
        }
      }
      if (hits === 0) continue;
      const i = (py * size + px) * 4;
      buf[i + 3] = Math.round((hits / total) * 255);
    }
  }
  return buf;
}

/* ---------------------------------------------------------------------------
   ICO is a directory of embedded PNGs. 0 in the size byte means 256.
   --------------------------------------------------------------------------- */
function toIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const table = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    table.push(e);
    offset += png.length;
  }
  return Buffer.concat([dir, ...table, ...entries.map((e) => e.png)]);
}

/* ---------------------------------------------------------------------------
   The vector, for the favicon and anywhere a document wants the mark.

   The plate is the same superellipse the raster samples, not a rounded
   rectangle standing in for one. The chamfer is approximated with a second
   squircle inset by CHAMFER over a gradient, and the engraving with a lighter
   copy of the mark offset down the light axis so it shows along the far wall —
   both are cheap fakes of what the shader computes, and both hold up because a
   favicon is never large enough for the difference to show.
   --------------------------------------------------------------------------- */
function toSvg(size = 1024) {
  const inner = size * (1 - CHAMFER);
  const m = markPaths(size, { scale: 1 });
  const offset = size * 0.011;
  const stroke = (d, w) =>
    `<path d="${d}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Sley">
  <title>Sley</title>
  <defs>
    <linearGradient id="chamfer" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8d949f"/>
      <stop offset="0.55" stop-color="#2a2e35"/>
      <stop offset="1" stop-color="#0d0e12"/>
    </linearGradient>
    <linearGradient id="face" x1="0.12" y1="0" x2="0.88" y2="1">
      <stop offset="0" stop-color="#454a55"/>
      <stop offset="1" stop-color="#171920"/>
    </linearGradient>
    <g id="mark">
      ${m.braces.map((d) => stroke(d, m.braceWidth)).join("\n      ")}
      ${stroke(m.dash, m.dashWidth)}
    </g>
  </defs>
  <path d="${squirclePath(size)}" fill="url(#chamfer)"/>
  <g transform="translate(${(size - inner) / 2} ${(size - inner) / 2}) scale(${1 - CHAMFER})">
    <path d="${squirclePath(size)}" fill="url(#face)"/>
  </g>
  <use href="#mark" transform="translate(${(offset * 0.42).toFixed(1)} ${offset.toFixed(1)})" stroke="#79808c" opacity="0.6"/>
  <use href="#mark" stroke="#0f1116"/>
</svg>
`;
}

/* ---------------------------------------------------------------------------
   Emit.
   --------------------------------------------------------------------------- */
mkdirSync(buildDir, { recursive: true });

const ICONSET = join(buildDir, "icon.iconset");
rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

for (const [base, mult] of [
  [16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2],
  [256, 1], [256, 2], [512, 1], [512, 2],
]) {
  const px = base * mult;
  const name = mult === 1 ? `icon_${base}x${base}.png` : `icon_${base}x${base}@2x.png`;
  writeFileSync(join(ICONSET, name), toPng(raster(px, MAC_INSET, iconShader, samples(px)), px, px));
}
execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", join(buildDir, "icon.icns")]);
rmSync(ICONSET, { recursive: true, force: true });

writeFileSync(
  join(buildDir, "icon.png"),
  toPng(raster(1024, FULL_BLEED, iconShader, samples(1024)), 1024, 1024),
);

/* `app.dock.setIcon` paints its bitmap across the whole dock tile rather than
   applying the system grid an .icns gets, so the dev dock needs the mac inset
   baked in. Handing it icon.png makes Sley stand a quarter wider than every
   neighbour. */
writeFileSync(
  join(buildDir, "icon-dock.png"),
  toPng(raster(1024, MAC_INSET, iconShader, samples(1024)), 1024, 1024),
);

writeFileSync(
  join(buildDir, "icon.ico"),
  toIco(
    [16, 24, 32, 48, 64, 128, 256].map((size) => ({
      size,
      png: toPng(raster(size, FULL_BLEED, iconShader, samples(size)), size, size),
    })),
  ),
);

writeFileSync(join(buildDir, "trayTemplate.png"), toPng(renderTray(16), 16, 16));
writeFileSync(join(buildDir, "trayTemplate@2x.png"), toPng(renderTray(32), 32, 32));

const svg = toSvg();
writeFileSync(join(buildDir, "icon.svg"), svg);

/* The web favicon is written from here rather than copied by hand.
   A copy plus a comment asking the next person to keep it in sync is what the
   old three-bar mark had, and the two files had already drifted apart by the
   time anyone looked. Writing across the package boundary is the smaller
   problem: the favicon cannot go stale if regenerating the icons rewrites it. */
const faviconPath = join(here, "..", "..", "web", "public", "favicon.svg");
writeFileSync(
  faviconPath,
  svg.replace(
    "  <title>Sley</title>\n",
    `  <title>Sley</title>
  <!-- GENERATED. Written by apps/desktop/scripts/make-icons.mjs, from the
       geometry in apps/desktop/scripts/lib/mark.mjs. Do not hand-edit: the next
       \`npm run icons\` overwrites this file. -->\n`,
  ),
);

const bytes = (p) => readFileSync(join(buildDir, p)).length;
console.log(
  [
    "icon.icns", "icon.ico", "icon.png", "icon-dock.png", "icon.svg",
    "trayTemplate.png", "trayTemplate@2x.png",
  ]
    .map((p) => `${p.padEnd(20)} ${bytes(p)} bytes`)
    .concat(`${"web favicon.svg".padEnd(20)} ${readFileSync(faviconPath).length} bytes`)
    .join("\n"),
);

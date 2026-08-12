/**
 * Generates every app-icon file from one description, in pure Node.
 *
 * The mark is three vertical rails of falling height — the same glyph the web
 * UI draws inline (apps/web/src/components/atoms.tsx, BrandGlyph). It is
 * rasterised here rather than converted from SVG because every renderer on this
 * machine disagrees about SVG anti-aliasing, and an app icon is the one asset
 * where a half-pixel of softness is visible forever. Rounded rectangles and a
 * superellipse are cheap to sample directly, so there is no dependency and the
 * output is byte-identical on any machine.
 *
 *   node scripts/make-icons.mjs
 *
 * Writes build/icon.icns, build/icon.ico, build/icon.png and build/icon.svg.
 * electron-builder picks those up from buildResources by name.
 */
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, "..", "build");

/* ---------------------------------------------------------------------------
   The mark.

   Geometry is expressed on the same 14×14 grid as BrandGlyph so the icon and
   the in-app mark cannot drift. Opacity carries the "falling" reading at sizes
   where the height difference alone stops being legible.
   --------------------------------------------------------------------------- */
const GRID = 14;
/**
 * Wider bars and tighter gaps than a first pass at this shape wants. At 16px
 * the whole mark is about 8px across: 2-unit bars separated by 3-unit gaps
 * rasterise to roughly one pixel each with two of air between them, which reads
 * as an audio meter rather than a mark. 2.6 and 1.9 hold the three-rail
 * silhouette down to 16px. The lowest opacity is 0.5 for the same reason —
 * 0.4 white on this plate disappears once anti-aliasing takes a bite out of it.
 */
const BARS = [
  { x: 1.7, y: 0, w: 2.6, h: 14, alpha: 1.0 },
  { x: 6.2, y: 2, w: 2.6, h: 10, alpha: 0.72 },
  { x: 10.7, y: 4, w: 2.6, h: 6, alpha: 0.5 },
];

/** Near-black, not black: #000 on an OLED dock loses the squircle's edge. */
const BG_TOP = [0x18, 0x19, 0x1d];
const BG_BOTTOM = [0x0b, 0x0c, 0x0e];
const INK = [0xff, 0xff, 0xff];

/** 4× per axis. 16 samples a pixel is past the point where more is visible. */
const SS = 4;

/**
 * Signed coverage of a superellipse, |x/a|^n + |y/b|^n <= 1.
 *
 * n = 5 is the usual approximation of the macOS icon shape. A plain rounded
 * rectangle reads subtly wrong beside other icons in the dock — the corners
 * turn too late.
 */
function inSquircle(px, py, cx, cy, a, b, n = 5) {
  const dx = Math.abs((px - cx) / a);
  const dy = Math.abs((py - cy) / b);
  return Math.pow(dx, n) + Math.pow(dy, n) <= 1;
}

/** Axis-aligned rounded rectangle, radius clamped to half the short side. */
function inRoundRect(px, py, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const ix = px < x + rr ? x + rr : px > x + w - rr ? x + w - rr : px;
  const iy = py < y + rr ? y + rr : py > y + h - rr ? y + h - rr : py;
  const dx = px - ix;
  const dy = py - iy;
  return dx * dx + dy * dy <= rr * rr;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Renders one RGBA buffer.
 *
 * `inset` is the fraction of the canvas the squircle leaves empty on each side.
 * macOS wants the mark to sit inside a 824/1024 plate; Windows and Linux draw
 * the icon edge to edge, so they pass 0.
 */
function render(size, inset) {
  const plate = size * (1 - inset * 2);
  const x0 = (size - plate) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const a = plate / 2;

  /* The mark occupies 56% of the plate, centred. Anything larger stops reading
     as a mark and starts reading as a texture. */
  const unit = (plate * 0.56) / GRID;
  const markX = cx - (GRID * unit) / 2;
  const markY = cy - (GRID * unit) / 2;

  const buf = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  const offset = step / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      // Per-bar coverage, so overlapping alphas never double-composite.
      const inkHits = new Array(BARS.length).fill(0);

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + sx * step + offset;
          const fy = py + sy * step + offset;
          if (!inSquircle(fx, fy, cx, cy, a, a)) continue;
          bgHits++;
          for (let i = 0; i < BARS.length; i++) {
            const b = BARS[i];
            if (
              inRoundRect(
                fx,
                fy,
                markX + b.x * unit,
                markY + b.y * unit,
                b.w * unit,
                b.h * unit,
                unit,
              )
            ) {
              inkHits[i]++;
            }
          }
        }
      }

      const total = SS * SS;
      const idx = (py * size + px) * 4;
      if (bgHits === 0) continue;

      // Vertical lift: flat near-black looks dead behind a white mark.
      const t = (py - x0) / plate;
      let [r, g, b] = mix(BG_TOP, BG_BOTTOM, Math.min(Math.max(t, 0), 1));

      for (let i = 0; i < BARS.length; i++) {
        if (inkHits[i] === 0) continue;
        const cover = (inkHits[i] / total) * BARS[i].alpha;
        [r, g, b] = [
          Math.round(r + (INK[0] - r) * cover),
          Math.round(g + (INK[1] - g) * cover),
          Math.round(b + (INK[2] - b) * cover),
        ];
      }

      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = Math.round((bgHits / total) * 255);
    }
  }
  return buf;
}

/* ---------------------------------------------------------------------------
   PNG. Colour type 6 (RGBA), 8-bit, one IDAT, filter 0 on every scanline.
   --------------------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO is a directory of embedded PNGs. 0 in the size byte means 256. */
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
   Emit.
   --------------------------------------------------------------------------- */
mkdirSync(buildDir, { recursive: true });

/* macOS. The plate is inset so the squircle matches the system grid; iconutil
   turns the .iconset into the .icns Apple's tooling expects. */
const ICONSET = join(buildDir, "icon.iconset");
rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

const MAC_INSET = 0.098; // 824 of 1024
for (const [base, scale] of [
  [16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2],
  [256, 1], [256, 2], [512, 1], [512, 2],
]) {
  const px = base * scale;
  const name = scale === 1 ? `icon_${base}x${base}.png` : `icon_${base}x${base}@2x.png`;
  writeFileSync(join(ICONSET, name), toPng(render(px, MAC_INSET), px));
}
execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", join(buildDir, "icon.icns")]);
rmSync(ICONSET, { recursive: true, force: true });

/* Windows and Linux draw the icon edge to edge. electron-builder requires the
   Linux/base PNG to be at least 512×512; 1024 is what it prefers. */
const FULL_BLEED = 0.0;
writeFileSync(join(buildDir, "icon.png"), toPng(render(1024, FULL_BLEED), 1024));
writeFileSync(
  join(buildDir, "icon.ico"),
  toIco(
    [16, 24, 32, 48, 64, 128, 256].map((size) => ({
      size,
      png: toPng(render(size, FULL_BLEED), size),
    })),
  ),
);

/* macOS menu bar. A template image: pure black plus alpha, and nothing else —
   the system recolours it for light and dark menu bars and for selection. No
   plate, just the mark, sized so 16pt logical reads at menu-bar weight. */
function renderTray(size) {
  const margin = size / 16;
  const unit = (size - margin * 2) / GRID;
  const buf = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  const offset = step / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const inkHits = new Array(BARS.length).fill(0);
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + sx * step + offset;
          const fy = py + sy * step + offset;
          for (let i = 0; i < BARS.length; i++) {
            const b = BARS[i];
            if (
              inRoundRect(
                fx,
                fy,
                margin + b.x * unit,
                margin + b.y * unit,
                b.w * unit,
                b.h * unit,
                unit,
              )
            ) {
              inkHits[i]++;
            }
          }
        }
      }
      // Bars never overlap, so summing per-bar coverage cannot exceed one.
      let alpha = 0;
      for (let i = 0; i < BARS.length; i++) {
        alpha += (inkHits[i] / (SS * SS)) * BARS[i].alpha;
      }
      const idx = (py * size + px) * 4;
      buf[idx] = 0;
      buf[idx + 1] = 0;
      buf[idx + 2] = 0;
      buf[idx + 3] = Math.round(Math.min(alpha, 1) * 255);
    }
  }
  return buf;
}

writeFileSync(join(buildDir, "trayTemplate.png"), toPng(renderTray(16), 16));
writeFileSync(join(buildDir, "trayTemplate@2x.png"), toPng(renderTray(32), 32));

/* The same mark as vector, for the web UI's favicon and anywhere a document
   wants it. Kept in this file so the two definitions cannot drift. */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="${GRID}" height="${GRID}">
  <rect width="${GRID}" height="${GRID}" rx="3.15" fill="#0E0F11"/>
${BARS.map(
  (b) =>
    `  <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="1" fill="#fff" opacity="${b.alpha}"/>`,
).join("\n")}
</svg>
`;
writeFileSync(join(buildDir, "icon.svg"), svg);

const bytes = (p) => readFileSync(join(buildDir, p)).length;
console.log(
  [
    `icon.icns  ${bytes("icon.icns")} bytes`,
    `icon.ico   ${bytes("icon.ico")} bytes`,
    `icon.png   ${bytes("icon.png")} bytes (1024×1024)`,
    `icon.svg   ${bytes("icon.svg")} bytes`,
    `trayTemplate.png     ${bytes("trayTemplate.png")} bytes (16×16)`,
    `trayTemplate@2x.png  ${bytes("trayTemplate@2x.png")} bytes (32×32)`,
  ].join("\n"),
);

/**
 * A tiny signed-distance renderer, enough to shade one app icon.
 *
 * The icon is not drawn, it is sampled. Every pixel asks the same questions —
 * how far am I from the plate edge, which way does the surface face here, how
 * far am I from the mark — and the answers are shaded into a colour. That keeps
 * one description of the artwork working at 16px and at 1024px, and it means a
 * change to the shape is a change to a number rather than to a drawing.
 *
 * Two coordinate systems appear throughout:
 *
 *   plate space   the origin is the centre of the plate and 1.0 is half its
 *                 width, so geometry is written once and never restated per size
 *   pxw           the width of one output pixel measured in plate space, which
 *                 is how a feature knows to stop shrinking before it disappears
 *
 * No dependencies. The PNG encoder is here because pulling in a library to
 * write seven files is a worse trade than sixty lines of deflate plumbing.
 */
import { deflateSync } from "node:zlib";

/** Apple's icon grid: an 824-wide plate on a 1024 canvas. */
export const MAC_INSET = 0.098;

/**
 * Direction of the key light, pointing *toward* it. Up and to the left, which
 * is where every operating system has assumed light comes from since 1984 —
 * break it and the icon reads as a hole instead of an object.
 */
export const LIGHT = (() => {
  const [x, y] = [-0.45, -0.89];
  const m = Math.hypot(x, y);
  return [x / m, y / m];
})();

/* ---------------------------------------------------------------------------
   Scalars and colour.
   --------------------------------------------------------------------------- */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/** A smooth pulse: 1 at the centre, 0 at |x| >= w. Used for hairlines. */
export function bump(x, w) {
  return smoothstep(0, 1, clamp(1 - Math.abs(x) / w, 0, 1));
}

/**
 * A feature size that refuses to fall below roughly a pixel.
 *
 * Anti-aliasing widths, chamfer hairlines and groove walls are all specified in
 * plate space so they scale, but a chamfer that is a thousandth of the plate is
 * invisible at 32px and shimmers at 16px. Clamping each one to at least `k`
 * pixels is what lets one description survive the whole size range.
 */
export const feature = (base, pxw, k = 1) => Math.max(base, pxw * k);

export const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

export const mixRgb = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Add light. Negative darkens, which is how a surface turned away is drawn. */
export const add = (c, v) => [
  clamp(c[0] + v, 0, 255),
  clamp(c[1] + v, 0, 255),
  clamp(c[2] + v, 0, 255),
];

export const scale = (c, k) => [
  clamp(c[0] * k, 0, 255),
  clamp(c[1] * k, 0, 255),
  clamp(c[2] * k, 0, 255),
];

/* ---------------------------------------------------------------------------
   Distance fields.
   --------------------------------------------------------------------------- */
/**
 * The plate: |x|^n + |y|^n = 1.
 *
 * n = 5 is the usual approximation of the macOS icon shape. A plain rounded
 * rectangle reads subtly wrong beside other icons in the dock — its corners
 * turn too late. Returns both the distance and the surface normal, because
 * every caller that wants one wants the other a line later.
 *
 * The distance is the implicit function divided by its gradient, which is not
 * exact but is correct to first order near the boundary. That is the only place
 * it is ever read.
 */
export function superellipse(x, y, a = 1, n = 5) {
  const ax = Math.abs(x / a);
  const ay = Math.abs(y / a);
  const f = Math.pow(ax, n) + Math.pow(ay, n) - 1;
  const gx = (n / a) * Math.pow(ax, n - 1) * Math.sign(x || 1e-9);
  const gy = (n / a) * Math.pow(ay, n - 1) * Math.sign(y || 1e-9);
  const g = Math.hypot(gx, gy) || 1e-9;
  return { d: f / g, nx: gx / g, ny: gy / g };
}

export function normalSuperellipse(x, y, a = 1, n = 5) {
  const s = superellipse(x, y, a, n);
  return [s.nx, s.ny];
}

export function sdRoundBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Unsigned distance to a line segment. */
export function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** A stroked open path: the union of its segments, offset by the stroke radius. */
export function sdPolyline(px, py, pts, r) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = sdSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < best) best = d;
  }
  return best - r;
}

/* ---------------------------------------------------------------------------
   Shading.
   --------------------------------------------------------------------------- */
/**
 * The lit edge of the plate itself: a bright hairline just inside the boundary
 * where it turns toward the light, and a faint dark one where it turns away.
 *
 * This is the detail that separates an object from a coloured rectangle. It has
 * to sit *inside* the edge rather than on it, or anti-aliasing eats it.
 */
export function rimLight(c, x, y, d, pxw, key = 84, fill = 20) {
  const w = feature(0.005, pxw, 1.2);
  const band = bump(d + w, w);
  const [nx, ny] = normalSuperellipse(x, y);
  const facing = nx * LIGHT[0] + ny * LIGHT[1];
  return add(c, band * (facing >= 0 ? key * facing : fill * facing));
}

/**
 * Cuts a mark into a surface instead of painting one on top of it.
 *
 * A white glyph laid over a plate is a sticker, and it throws away the material
 * the rest of the icon works so hard to establish. A groove keeps it: the floor
 * sits in shadow, the wall on the light side faces away and goes dark, and the
 * wall opposite turns into the light and picks up a highlight. Those two walls
 * are the entire illusion — without them a groove is just a darker shape.
 *
 * Both walls are found by resampling the field a pixel or so along the light
 * axis. A point that is inside the mark now but outside it once nudged toward
 * the light must be sitting on the near wall, and the far wall is the same test
 * run backwards. This costs two extra field evaluations and needs no normals.
 */
export function engrave(c, sdf, x, y, pxw, opts = {}) {
  const { depth = 0.46, key = 104, dark = 0.6 } = opts;
  const g = sdf(x, y);
  const w = feature(0.014, pxw, 1.4);
  if (g > w * 2) return c;

  const aa = feature(0.003, pxw);
  const inside = 1 - smoothstep(-aa, aa, g);
  if (inside <= 0) return c;

  let out = mixRgb(c, scale(c, 1 - depth), inside);
  const near = inside * smoothstep(-aa, aa, sdf(x + LIGHT[0] * w, y + LIGHT[1] * w));
  const far = inside * smoothstep(-aa, aa, sdf(x - LIGHT[0] * w, y - LIGHT[1] * w));
  out = scale(out, 1 - dark * near);
  return add(out, key * far);
}

/* ---------------------------------------------------------------------------
   Rasterising.
   --------------------------------------------------------------------------- */
/**
 * Samples `shade` over one square RGBA image.
 *
 * `inset` is the fraction of the canvas the plate leaves empty on each side:
 * MAC_INSET for anything macOS reads, 0 for Windows and Linux, which draw their
 * own margin around whatever they are given.
 *
 * Colour is averaged over the covered subsamples only. Averaging over all of
 * them instead would blend the plate toward black along every edge, which reads
 * as a dark fringe once the icon sits on a light background.
 */
export function raster(size, inset, shade, ss = 4) {
  const half = (size * (1 - inset * 2)) / 2;
  const c = size / 2;
  const pxw = 1 / half;
  const aa = pxw * 0.7;
  const step = 1 / ss;
  const off = step / 2;
  const total = ss * ss;
  const buf = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cov = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + sx * step + off - c) / half;
          const y = (py + sy * step + off - c) / half;
          const s = superellipse(x, y);
          const a = 1 - smoothstep(-aa, aa, s.d);
          if (a <= 0) continue;
          const col = shade(x, y, { pxw, d: s.d });
          r += col[0] * a;
          g += col[1] * a;
          b += col[2] * a;
          cov += a;
        }
      }

      if (cov <= 0) continue;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(r / cov);
      buf[i + 1] = Math.round(g / cov);
      buf[i + 2] = Math.round(b / cov);
      buf[i + 3] = Math.round((cov / total) * 255);
    }
  }
  return buf;
}

/**
 * A hero at 256 plus 64, 32 and 16 at their real size, on mid grey.
 *
 * The small column is the point. A mark that only works in the hero is a mark
 * that does not work, and nothing reveals that faster than seeing all four at
 * once with nothing to flatter them.
 */
const SHEET_BG = [0x6e, 0x70, 0x74];

export function contactSheet(shade) {
  const hero = 256;
  const smalls = [64, 32, 16];
  const pad = 20;
  const gutter = 28;
  const w = pad + hero + gutter + 64 + pad;
  const h = pad + hero + pad;
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    out[i * 3] = SHEET_BG[0];
    out[i * 3 + 1] = SHEET_BG[1];
    out[i * 3 + 2] = SHEET_BG[2];
  }

  const blit = (rgba, size, dx, dy) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4;
        const a = rgba[s + 3] / 255;
        if (a === 0) continue;
        const d = ((dy + y) * w + dx + x) * 3;
        for (let ch = 0; ch < 3; ch++) {
          out[d + ch] = Math.round(out[d + ch] * (1 - a) + rgba[s + ch] * a);
        }
      }
    }
  };

  blit(raster(hero, MAC_INSET, shade, 3), hero, pad, pad);
  let y = pad;
  for (const size of smalls) {
    blit(raster(size, MAC_INSET, shade, 4), size, pad + hero + gutter, y);
    y += size + 16;
  }
  return { buf: out, w, h };
}

/* ---------------------------------------------------------------------------
   PNG. 8-bit, one IDAT, filter 0 on every scanline.
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

export function toPng(buf, w, h, channels = 4) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stride = w * channels;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    buf.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

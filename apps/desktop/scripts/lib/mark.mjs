/**
 * The Sley mark, defined once.
 *
 * Braces with one line of mail inside them, engraved into a machined plate:
 * code on the outside, a message in the middle. Every surface that carries the
 * brand — the .icns, the .ico, the Linux PNG, the menu bar template, the
 * favicon, the inline glyph in the web UI — derives from the constants and the
 * distance field in this file, so none of them can drift from each other.
 *
 * Coordinates are in *plate space*: the origin is the centre of the plate and
 * 1.0 is half its width. See lib/icon-engine.mjs for the renderer.
 */
import {
  LIGHT,
  add,
  bump,
  clamp,
  engrave,
  feature,
  mixRgb,
  normalSuperellipse,
  rgb,
  rimLight,
  sdPolyline,
  sdSegment,
  smoothstep,
} from "./icon-engine.mjs";

/* ---------------------------------------------------------------------------
   Geometry.
   --------------------------------------------------------------------------- */
export const BRACE = {
  /** Distance from centre to each brace's spine. */
  spine: 0.25,
  /** How far the top and bottom arms turn back outward. */
  arm: 0.14,
  /** How far the middle pinch reaches in toward the message. */
  notch: 0.12,
  /** Half the spine's height. */
  half: 0.32,
  /** Half the height of the pinch, which is what keeps the brace from being a bracket. */
  waist: 0.05,
  /** Stroke radius. */
  r: 0.047,
};

export const DASH = { half: 0.09, r: 0.048 };

/** The chamfer, as a fraction of the plate's half-width. */
export const CHAMFER = 0.12;

export const FACE = [rgb("#3d424b"), rgb("#171920")];

/** Half-extent of the mark's bounding box, used to fit it into the tray. */
export const MARK_EXTENT = {
  x: BRACE.spine + BRACE.notch + BRACE.r,
  y: BRACE.half + BRACE.r,
};

function bracePoints(spine, dir) {
  const { arm, notch, half, waist } = BRACE;
  return [
    [spine + dir * arm, -half],
    [spine, -half],
    [spine, -waist],
    [spine - dir * notch, 0],
    [spine, waist],
    [spine, half],
    [spine + dir * arm, half],
  ];
}

export const LEFT_BRACE = bracePoints(-BRACE.spine, 1);
export const RIGHT_BRACE = bracePoints(BRACE.spine, -1);

/**
 * Signed distance to the mark.
 *
 * `weight` scales the stroke without moving the skeleton. The plate can afford
 * a fine engraved line; the menu bar cannot, and needs the same shape drawn
 * heavier to survive as a 16px silhouette.
 */
export function sdMark(x, y, weight = 1) {
  return Math.min(
    sdPolyline(x, y, LEFT_BRACE, BRACE.r * weight),
    sdPolyline(x, y, RIGHT_BRACE, BRACE.r * weight),
    sdSegment(x, y, -DASH.half, 0, DASH.half, 0) - DASH.r * weight,
  );
}

/* ---------------------------------------------------------------------------
   Shading.
   --------------------------------------------------------------------------- */
/** The plate on its own: a chamfer cut around a flat face, lit from upper left. */
export function bevelFace(x, y, { pxw, d }) {
  const along = clamp((x * LIGHT[0] + y * LIGHT[1]) * -0.5 + 0.5, 0, 1);
  let c = mixRgb(FACE[0], FACE[1], along);

  const [nx, ny] = normalSuperellipse(x, y, 1, 5);
  const facing = nx * LIGHT[0] + ny * LIGHT[1];
  const inner = -d;
  const aa = feature(0.004, pxw);

  c = add(c, (1 - smoothstep(CHAMFER - aa, CHAMFER + aa, inner)) * facing * 104);
  c = add(c, 46 * facing * bump(inner - CHAMFER, feature(0.008, pxw, 1.3)));

  return rimLight(c, x, y, d, pxw, 84, 20);
}

/** The full icon: the plate, with the mark cut into it. */
export function iconShader(x, y, ctx) {
  return engrave(bevelFace(x, y, ctx), (gx, gy) => sdMark(gx, gy), x, y, ctx.pxw);
}

/* ---------------------------------------------------------------------------
   SVG. Emitted rather than hand-written so the vector and the raster cannot
   disagree about where a brace sits.
   --------------------------------------------------------------------------- */
const f = (v) => Number(v.toFixed(2));

/** The plate outline as a path, sampled from the same superellipse the raster uses. */
export function squirclePath(size, steps = 96, n = 5) {
  const r = size / 2;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([
      f(r + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * r),
      f(r + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * r),
    ]);
  }
  return `M${pts.map(([x, y]) => `${x} ${y}`).join("L")}Z`;
}

/**
 * The mark as three stroked paths, sized for a viewBox of `size`.
 *
 * `scale` shrinks or grows the mark inside the viewBox. The icon's plate spans
 * the whole box, so it passes 1; a bare inline glyph wants the mark to reach the
 * edges instead of floating in dead space, so it passes more.
 */
export function markPaths(size, { scale = 1, weight = 1 } = {}) {
  const half = size / 2;
  const s = (v) => f(v * half * scale);
  const px = (x) => f(half + x * half * scale);
  const py = (y) => f(half + y * half * scale);
  const brace = (points) => `M${points.map(([x, y]) => `${px(x)} ${py(y)}`).join("L")}`;
  return {
    braces: [brace(LEFT_BRACE), brace(RIGHT_BRACE)],
    dash: `M${px(-DASH.half)} ${py(0)}L${px(DASH.half)} ${py(0)}`,
    braceWidth: s(BRACE.r * 2 * weight),
    dashWidth: s(DASH.r * 2 * weight),
  };
}

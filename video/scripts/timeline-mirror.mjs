/**
 * A plain-JS mirror of `src/timeline.ts`, for Node versions that cannot import
 * TypeScript directly. `make-music.mjs` prefers the real module and falls back
 * to this. Keep the two in step.
 */
export const FPS = 30;
export const X = 16;
export const ACTS = [
  { id: "hook", frames: 150 },
  { id: "inbox", frames: 225 },
  { id: "ask", frames: 240 },
  { id: "agent", frames: 420 },
  { id: "approval", frames: 225 },
  { id: "automations", frames: 225 },
  { id: "local", frames: 165 },
  { id: "cta", frames: 180 },
];
export const START = (() => {
  const out = {};
  let s = 0;
  for (const a of ACTS) {
    out[a.id] = s;
    s += a.frames - X;
  }
  return out;
})();
export const TOTAL =
  ACTS.reduce((sum, a) => sum + a.frames, 0) - X * (ACTS.length - 1);

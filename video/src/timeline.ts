/**
 * The single source of truth for the cut's shape.
 *
 * `src/Launch.tsx` builds the TransitionSeries from this, and
 * `scripts/make-music.mjs` and `scripts/make-voiceover.mjs` both read it.
 *
 * Eight beats, in the order somebody deciding whether to install this actually
 * asks their questions:
 *
 *   what is it -> what does it look like -> what do I say to it -> what does
 *   it do -> can I trust it -> what happens while I'm away -> where does my
 *   mail live -> how do I get it
 *
 * The agent beat is by far the longest, and deliberately so: it is the only
 * beat that shows the product doing the thing the product is for. An earlier
 * cut gave it eight seconds and ran six activity lines through it in three;
 * you could not read a single one. It now gets fourteen seconds and the lines
 * land one every second and a half.
 *
 * Every other beat is longer than it needs to be for its animation, because
 * the animation is not the point — the still frame after it is. Something
 * arrives, then it stops, then it is read.
 */
export const FPS = 30;

/** Cross-fade length between beats, in frames. Long, so cuts feel unhurried. */
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
] as const;

export type ActId = (typeof ACTS)[number]["id"];

/** The frame each beat starts on in the finished timeline. */
export const START: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let s = 0;
  for (const a of ACTS) {
    out[a.id] = s;
    s += a.frames - X;
  }
  return out;
})();

export const TOTAL =
  ACTS.reduce((sum, a) => sum + a.frames, 0) - X * (ACTS.length - 1);

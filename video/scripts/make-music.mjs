/**
 * Writes `public/soundtrack.wav` — the video's music, synthesised from scratch.
 *
 * Why synthesise rather than license a stock track: this one is cut to the
 * video instead of the other way round. Every section boundary below is an act
 * boundary in `src/Launch.tsx`, so the drop lands on the product reveal and the
 * filter opens on the agent scene rather than four bars late. It also removes
 * the licence question from a video attached to an MIT launch post.
 *
 * 124 BPM in A minor. One bar is 4 beats; at 30fps a bar is 58.06 frames, which
 * is why the act lengths in Launch.tsx are what they are.
 *
 *   node scripts/make-music.mjs
 *
 * Deterministic: same input, same bytes. No dependencies.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "soundtrack.wav");

const SR = 48000;
const BPM = 124;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const FPS = 30;

// The cut's shape, read from the same module the video builds from, so the
// arrangement cannot drift out of sync with the acts.
const TL = await import("../src/timeline.ts").catch(() => null);
const { ACTS, START, TOTAL } = TL ?? (await import("./timeline-mirror.mjs"));
const TOTAL_FRAMES = TOTAL;
const DURATION = TOTAL_FRAMES / FPS + 0.4; // a little tail for the last reverb

const N = Math.ceil(DURATION * SR);
const L = new Float64Array(N);
const R = new Float64Array(N);

/* ------------------------------------------------------------------ util */

const TAU = Math.PI * 2;

/** A deterministic noise source. Math.random would break reproducibility. */
let seed = 0x2f6e2b1;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed |= 0;
  return (seed >>> 0) / 0xffffffff - 0.5;
};

const NOTE = (semitonesFromA4) => 440 * Math.pow(2, semitonesFromA4 / 12);
/** A minor, written relative to A2 so the bass sits where a sub belongs. */
const n = {
  A1: NOTE(-36), C2: NOTE(-33), D2: NOTE(-31), E2: NOTE(-29), F2: NOTE(-28), G2: NOTE(-26),
  A2: NOTE(-24), C3: NOTE(-21), D3: NOTE(-19), E3: NOTE(-17), F3: NOTE(-16), G3: NOTE(-14),
  A3: NOTE(-12), B3: NOTE(-10), C4: NOTE(-9), D4: NOTE(-7), E4: NOTE(-5), F4: NOTE(-4),
  G4: NOTE(-2), A4: NOTE(0), C5: NOTE(3), E5: NOTE(7), A5: NOTE(12),
};

const add = (t, sample, pan = 0) => {
  const i = Math.round(t * SR);
  if (i < 0 || i >= N) return;
  L[i] += sample * (1 - Math.max(0, pan));
  R[i] += sample * (1 + Math.min(0, pan));
};

/** Exponential decay envelope, the workhorse for every percussive voice. */
const decay = (x, tau) => Math.exp(-x / tau);
/** Attack/decay so a pluck does not click on its first sample. */
const ad = (x, a, tau) => (x < a ? x / a : decay(x - a, tau));

/* ---------------------------------------------------------------- voices */

function kick(t0, gain = 1) {
  const dur = 0.42;
  for (let x = 0; x < dur; x += 1 / SR) {
    // Pitch sweep from 118Hz to 42Hz: the click and the body in one oscillator.
    const f = 42 + 76 * decay(x, 0.028);
    const env = decay(x, 0.14) * (1 - decay(x, 0.002));
    add(t0 + x, Math.sin(TAU * f * x) * env * 0.92 * gain);
  }
}

function sub(t0, freq, dur, gain = 1) {
  for (let x = 0; x < dur; x += 1 / SR) {
    const env = ad(x, 0.008, dur * 0.55) * (x > dur - 0.03 ? (dur - x) / 0.03 : 1);
    // A touch of second harmonic so it survives a phone speaker that cannot
    // reproduce 55Hz at all.
    const s =
      Math.sin(TAU * freq * x) * 0.8 + Math.sin(TAU * freq * 2 * x) * 0.22;
    add(t0 + x, s * env * 0.5 * gain);
  }
}

function hat(t0, gain = 1, open = false) {
  const dur = open ? 0.16 : 0.045;
  let hp = 0;
  for (let x = 0; x < dur; x += 1 / SR) {
    const raw = rnd();
    hp = 0.86 * (hp + raw); // crude one-pole high-pass
    const env = decay(x, open ? 0.07 : 0.014);
    add(t0 + x, hp * env * 0.14 * gain, 0.12);
  }
}

function clap(t0, gain = 1) {
  // Three short bursts then a tail — the shape that reads as hands, not noise.
  for (const [off, amp] of [[0, 0.7], [0.011, 0.85], [0.023, 1]]) {
    for (let x = 0; x < 0.05; x += 1 / SR) {
      add(t0 + off + x, rnd() * decay(x, 0.008) * 0.5 * amp * gain);
    }
  }
  for (let x = 0; x < 0.24; x += 1 / SR) {
    add(t0 + 0.023 + x, rnd() * decay(x, 0.055) * 0.22 * gain);
  }
}

/** A short plucked saw, filtered by a simple one-pole. Carries the melody. */
function pluck(t0, freq, dur, gain = 1, pan = 0, bright = 1) {
  let lp = 0;
  const a = Math.min(0.9, 0.08 + 0.5 * bright);
  for (let x = 0; x < dur; x += 1 / SR) {
    const ph = (freq * x) % 1;
    const saw = ph * 2 - 1;
    const sq = ph < 0.5 ? 0.35 : -0.35;
    lp += a * (saw + sq - lp);
    const env = ad(x, 0.004, dur * 0.4);
    add(t0 + x, lp * env * 0.16 * gain, pan);
  }
}

/** A slow detuned pad. Two saws a few cents apart, heavily low-passed. */
function pad(t0, freqs, dur, gain = 1) {
  let lp = 0;
  for (let x = 0; x < dur; x += 1 / SR) {
    let s = 0;
    for (const f of freqs) {
      s += Math.sin(TAU * f * x) + Math.sin(TAU * f * 1.004 * x) * 0.8;
    }
    lp += 0.06 * (s / (freqs.length * 2) - lp);
    const env =
      ad(x, 0.7, dur) * (x > dur - 0.9 ? Math.max(0, (dur - x) / 0.9) : 1);
    add(t0 + x, lp * env * 0.5 * gain);
  }
}

/** Rising noise sweep into a downbeat. */
function riser(t0, dur, gain = 1) {
  let bp = 0;
  let lp = 0;
  for (let x = 0; x < dur; x += 1 / SR) {
    const p = x / dur;
    const raw = rnd();
    const a = 0.02 + 0.5 * p * p;
    bp += a * (raw - bp);
    lp += 0.4 * (bp - lp);
    add(t0 + x, (bp - lp) * p * p * 0.5 * gain);
  }
}

/** The hit on a downbeat — noise burst plus a low sine thump. */
function impact(t0, gain = 1) {
  for (let x = 0; x < 1.1; x += 1 / SR) {
    add(t0 + x, rnd() * decay(x, 0.26) * 0.2 * gain);
    add(t0 + x, Math.sin(TAU * 58 * x) * decay(x, 0.3) * 0.4 * gain);
  }
}

/* ------------------------------------------------------------ arrangement
 *
 * Sections, in bars, keyed to the acts. `f2b` converts an act's start frame
 * into the bar it lands on, so a change to Launch.tsx moves the music with it.
 */
const barAt = (bar) => bar * BAR;

/** i-VI-III-VII in A minor: the four chords that make a launch video sound
 *  like a launch video, and the reason this is in A minor at all. */
const CHORDS = [
  [n.A2, n.A3, n.C4, n.E4],
  [n.F2, n.F3, n.A3, n.C4],
  [n.C3, n.C4, n.E4, n.G4],
  [n.G2, n.G3, n.B3, n.D4],
];
const ROOTS = [n.A1, n.F2, n.C2, n.G2];
/** The arp figure, as scale degrees into the chord above. */
const ARP = [0, 2, 3, 2, 1, 2, 3, 2];

const TOTAL_BARS = Math.ceil(DURATION / BAR);

/**
 * Density per act, not per bar: 0 = pad only, 1 = pad and sub, 2 = add the
 * kick and claps, 3 = everything including the arp.
 *
 * The shape is the argument of the video in sound. It opens on almost nothing,
 * slams in when the product appears, runs full through the two scenes that do
 * the selling, drops the drums under the guardrail beat so that claim is heard
 * rather than danced to, strips almost bare for the architecture diagram, and
 * comes back up for the call to action.
 */
const DENSITY = {
  hook: 0,
  inbox: 1,
  ask: 2,
  agent: 2,
  approval: 1,
  automations: 2,
  local: 1,
  cta: 2,
};

/** Which act a given time falls in. */
const actAt = (t) => {
  const frame = t * FPS;
  let found = ACTS[0].id;
  for (const a of ACTS) if (frame >= START[a.id]) found = a.id;
  return found;
};
const density = (t) => DENSITY[actAt(t)];

for (let bar = 0; bar < TOTAL_BARS; bar++) {
  const t = barAt(bar);
  const d = density(t);
  const chord = bar % 4;

  pad(t, CHORDS[chord], BAR * 1.02, d === 0 ? 0.55 : 0.34);

  if (d >= 1) {
    sub(t, ROOTS[chord], BEAT * 1.6, 0.9);
    sub(t + BEAT * 2, ROOTS[chord], BEAT * 1.2, 0.7);
  }

  if (d >= 2) {
    for (let b = 0; b < 4; b++) kick(t + b * BEAT, b === 0 ? 1 : 0.86);
    clap(t + BEAT, 0.75);
    clap(t + BEAT * 3, 0.75);
  }

  if (d >= 3) {
    for (let e = 0; e < 8; e++) {
      hat(t + e * (BEAT / 2) + BEAT / 4, e % 2 === 0 ? 0.9 : 0.55, e === 7);
    }
    // The arp: eighths, alternating pan, brighter as the video goes on.
    for (let e = 0; e < 8; e++) {
      const deg = ARP[e];
      const f = CHORDS[chord][1 + (deg % 3)] * (deg >= 3 ? 2 : 1);
      pluck(
        t + e * (BEAT / 2),
        f,
        BEAT * 0.42,
        0.85,
        e % 2 === 0 ? -0.35 : 0.35,
        Math.min(1, 0.35 + bar / 24),
      );
    }
  }
}

/**
 * Risers and impacts, placed on act starts rather than on bar lines. An impact
 * that lands half a beat off the cut is worse than no impact at all, so these
 * ignore the grid and hit the frame.
 */
const at = (actId) => START[actId] / FPS;
// Three, not six. A hit on every scene change is a hit on nothing, and this
// cut is supposed to feel unhurried: the product appearing, the moment the
// drums drop out under the trust claim, and the call to action.
riser(at("inbox") - BAR, BAR, 0.7);
impact(at("inbox"), 0.85); // the product appears
impact(at("approval"), 0.6); // the drums drop out here; the hit marks it
riser(at("cta") - BAR * 0.8, BAR * 0.8, 0.7);
impact(at("cta"), 0.8);

/* -------------------------------------------------------- master and file */

// Fade the last bar out under the CTA's own fade to black.
const fadeStart = (TOTAL_FRAMES / FPS - 1.6) * SR;
for (let i = 0; i < N; i++) {
  const fadeIn = Math.min(1, i / (SR * 0.25));
  const fadeOut = i < fadeStart ? 1 : Math.max(0, 1 - (i - fadeStart) / (SR * 1.6));
  const g = fadeIn * fadeOut * 0.62;
  L[i] *= g;
  R[i] *= g;
}

// Soft-clip rather than hard-limit: a launch video that crackles on one loud
// bar is worse than one that is 0.5dB quieter throughout.
const shape = (x) => Math.tanh(x * 1.15) * 0.86;

const bytes = Buffer.alloc(44 + N * 4);
bytes.write("RIFF", 0);
bytes.writeUInt32LE(36 + N * 4, 4);
bytes.write("WAVE", 8);
bytes.write("fmt ", 12);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20); // PCM
bytes.writeUInt16LE(2, 22); // stereo
bytes.writeUInt32LE(SR, 24);
bytes.writeUInt32LE(SR * 4, 28);
bytes.writeUInt16LE(4, 32);
bytes.writeUInt16LE(16, 34);
bytes.write("data", 36);
bytes.writeUInt32LE(N * 4, 40);

let peak = 0;
for (let i = 0; i < N; i++) {
  const l = shape(L[i]);
  const r = shape(R[i]);
  peak = Math.max(peak, Math.abs(l), Math.abs(r));
  bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), 44 + i * 4);
  bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), 46 + i * 4);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bytes);
console.log(
  `soundtrack.wav — ${DURATION.toFixed(2)}s, ${TOTAL_BARS} bars at ${BPM} BPM, peak ${peak.toFixed(3)}`,
);

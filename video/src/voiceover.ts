/**
 * The narration script, and where each line lands.
 *
 * **One narrator.** An earlier version used Fish Audio `s1`, which reads
 * inline emotion markers — but with no voice reference it picks a different
 * speaker on every request. Measured over three calls on the same sentence,
 * the median pitch came back at 181 Hz, 97 Hz and 156 Hz: a woman, a deep man
 * and a mid-range man narrating one 45-second video. That is why the script no
 * longer carries per-line emotion markers and why the generator now uses a
 * model with a named, deterministic voice (see `scripts/make-voiceover.mjs`).
 * The same measurement on the replacement showed 0.6 Hz of drift.
 *
 * The register is set once, for the whole script, by the `instructions` field
 * in the generator — calm, unhurried, explaining rather than selling. Changing
 * emotion line by line is what made it sound like an advert.
 *
 * Two rules the copy obeys:
 *
 *  1. **It never reads the caption aloud.** The caption carries the video with
 *     the sound off, so a voice repeating it wastes the only channel a viewer
 *     has to opt into. Each line says what the picture and the caption
 *     together do not.
 *  2. **It stays inside its beat, with silence around it.** Roughly half this
 *     video has nobody talking, which is deliberate: the beats that matter are
 *     the still ones after a line lands. `scripts/make-voiceover.mjs` measures
 *     the generated audio and warns if two lines overlap or if one runs past
 *     the beat it describes — the first draft of this script failed both
 *     checks and had to be cut down.
 *
 * The name is written "Box-aid" because that is how it is said. Every spelling
 * tested transcribed back identically with this voice, so the hyphen costs
 * nothing and removes the question.
 */
import durations from "./vo-durations.json";
import { FPS } from "./timeline";

export type VoLine = {
  id: string;
  /** Sent to the TTS model verbatim. */
  text: string;
  /** Frame the line starts on. */
  from: number;
};

/** Acronyms are spaced with full stops; every TTS model says "imap" otherwise. */
export const VO_SCRIPT: VoLine[] = [
  {
    id: "hook",
    from: 34,
    text: "This is Box-aid. A mail client your coding agent can use.",
  },
  {
    id: "inbox",
    from: 180,
    text: "Connect any I.M.A.P. account. Every mailbox lands in one list.",
  },
  {
    id: "ask",
    from: 400,
    text: "No commands to learn. You type what you want.",
  },
  {
    id: "agent-a",
    from: 620,
    text: "Your own agent picks it up. Claude Code, Codex, anything that speaks M.C.P.",
  },
  {
    id: "agent-b",
    from: 800,
    text: "And it tells you what it is doing, in plain words, as it goes.",
  },
  {
    id: "approval",
    from: 1020,
    text: "It cannot send. It shows you the message, and it waits.",
  },
  {
    id: "automations",
    from: 1230,
    text: "Tell it once what should happen every morning.",
  },
  {
    id: "local",
    from: 1425,
    text: "No account. No subscription. Nothing in the middle.",
  },
  {
    id: "cta",
    from: 1580,
    text: "Clone it, run it. It's open source, under M.I.T.",
  },
];

const measured = durations as Record<string, number>;

/**
 * The script, restricted to lines whose audio exists on disk, with their
 * measured lengths in frames. A line without a generated WAV is dropped rather
 * than rendered as a missing-asset error.
 */
export const VO_LINES: (VoLine & { durationInFrames: number })[] =
  VO_SCRIPT.filter((l) => typeof measured[l.id] === "number").map((l) => ({
    ...l,
    durationInFrames: Math.ceil(measured[l.id] * FPS),
  }));

/** True once narration has been generated. Drives the Root's default. */
export const HAS_VOICEOVER = VO_LINES.length > 0;

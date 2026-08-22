/**
 * Generates the narration and measures it.
 *
 *   AI_GATEWAY_API_KEY=... node scripts/make-voiceover.mjs
 *   SONIOX_API_KEY=...     node scripts/make-voiceover.mjs --provider soniox
 *   node scripts/make-voiceover.mjs --dry
 *
 * Everything goes through **Vercel AI Gateway**. The model matters:
 *
 *  - `openai/tts-1-hd` with a named voice is the default, because it is the
 *    only option tested that returns THE SAME SPEAKER every call. Measured by
 *    generating one sentence twice and comparing median pitch: 0.6 Hz apart.
 *  - `fish-audio/s1-free` is free on the Gateway through 18 September 2026 and
 *    reads inline emotion markers, which is why it was tried first. It cannot
 *    be used for narration: with no voice reference it picks a RANDOM SPEAKER
 *    per request. The same sentence three times came back at 181 Hz, 97 Hz and
 *    156 Hz — three different people in one video. Use it only if you supply a
 *    cloning reference. `--model fish-audio/s1-free` if you want to hear it.
 *  - `spacexai/grok-tts` sits in between: same speaker, but 16.8 Hz of drift
 *    between calls, which is audible across a cut.
 *  - **Soniox** `tts-rt-v2` remains reachable via `--provider soniox`. It is
 *    not the default because the available key returns 401 from Soniox's own
 *    account endpoint — revoked, not misconfigured.
 *
 * Cost at the default: the whole script is about 700 characters, so roughly
 * two US cents per full regeneration.
 *
 * For each line it writes `public/vo/<id>.wav`, then writes every measured
 * duration to `src/vo-durations.json`. The video reads that file to place each
 * clip and to duck the music under it, so a re-recorded line that came out
 * half a second longer moves its own duck window and nothing else.
 *
 * Idempotent: a line whose text, provider and voice are unchanged is skipped.
 * `--force` regenerates everything, `--dry` generates nothing.
 */
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const VO_DIR = join(ROOT, "public", "vo");
const DURATIONS = join(ROOT, "src", "vo-durations.json");
const CACHE = join(VO_DIR, ".cache.json");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const DRY = args.includes("--dry");
const FORCE = args.includes("--force");
const PROVIDER = flag("provider", "gateway");
const MODEL = flag(
  "model",
  PROVIDER === "soniox" ? "tts-rt-v2" : "openai/tts-1-hd",
);
const VOICE = flag("voice", PROVIDER === "soniox" ? "Adrian" : "onyx");

/**
 * The register, set once for the whole script rather than per line. Directing
 * emotion line by line is what made an earlier cut sound like an advert; a
 * single instruction keeps one person explaining one thing for 57 seconds.
 *
 * Ignored by models that do not support it, and reported in `warnings`.
 */
const INSTRUCTIONS =
  "Speak as a calm, confident engineer explaining something they built to a " +
  "colleague. Unhurried and even. Measured pace with real pauses at the full " +
  "stops. No advertising lilt, no rising enthusiasm, no salesmanship.";

/* --------------------------------------------------- the script to speak */

/**
 * Parsed out of `src/voiceover.ts` rather than imported, so this script needs
 * no TypeScript loader and runs on a bare `node`.
 */
function loadScript() {
  const src = readFileSync(join(ROOT, "src", "voiceover.ts"), "utf8");
  const body = src.slice(
    src.indexOf("export const VO_SCRIPT"),
    src.indexOf("const measured ="),
  );
  const lines = [];
  const re =
    /\{\s*id:\s*"([^"]+)",\s*from:\s*(\d+),\s*text:\s*"((?:[^"\\]|\\.)*)",?\s*\}/g;
  let m;
  while ((m = re.exec(body))) {
    lines.push({
      id: m[1],
      from: Number(m[2]),
      text: m[3].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
    });
  }
  if (lines.length === 0) {
    throw new Error("Parsed no lines out of src/voiceover.ts — has its shape changed?");
  }
  return lines;
}

/* --------------------------------------------------------------- helpers */

/** Seconds of audio in a PCM WAV, read from its own header. */
function wavDuration(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`${path} is not a RIFF file — did the API return an error body?`);
  }
  // Walk the chunk list rather than assuming a 44-byte header: a provider may
  // put a LIST/INFO chunk ahead of the data.
  let byteRate = 0;
  let dataBytes = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(off + 16);
    if (id === "data") {
      dataBytes = Math.min(size, buf.length - off - 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!byteRate || !dataBytes) throw new Error(`${path}: no fmt/data chunk`);
  return dataBytes / byteRate;
}

/** Re-encodes whatever the provider returned into the 48kHz WAV Remotion wants. */
function toWav(inputPath, outputPath) {
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-y", "-i", inputPath, "-ar", "48000", "-ac", "1", outputPath],
    { stdio: "pipe" },
  );
}

/* ------------------------------------------------------------- providers */

async function viaGateway(text) {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error("AI_GATEWAY_API_KEY is not set");

  const body = { text, outputFormat: "wav", instructions: INSTRUCTIONS };
  if (VOICE) body.voice = VOICE;

  const res = await fetch("https://ai-gateway.vercel.sh/v4/ai/speech-model", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "ai-model-id": MODEL,
      // Undocumented on the REST page but required: the endpoint 400s with
      // "Unsupported gateway protocol version" unless this is sent, and only
      // "0.0.1" is accepted (1, 2 and 3 are all rejected). The AI SDK sets it
      // for you, which is why the curl example in the docs omits it.
      "ai-gateway-protocol-version": "0.0.1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `AI Gateway ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`,
    );
  }
  const json = await res.json();
  if (!json.audio) throw new Error(`AI Gateway returned no audio: ${JSON.stringify(json).slice(0, 300)}`);
  for (const w of json.warnings ?? []) {
    console.warn(`      warning: ${w.type ?? ""} ${w.setting ?? ""} ${w.details ?? ""}`.trim());
  }
  return Buffer.from(json.audio, "base64");
}

async function viaSoniox(text) {
  const key = process.env.SONIOX_API_KEY;
  if (!key) throw new Error("SONIOX_API_KEY is not set");

  const res = await fetch("https://tts-rt.soniox.com/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      language: "en",
      voice: VOICE ?? "Adrian",
      audio_format: "wav",
      sample_rate: 48000,
      text,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Soniox ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

const synthesize = PROVIDER === "soniox" ? viaSoniox : viaGateway;

/* ------------------------------------------------------------------ main */

const script = loadScript();

if (DRY) {
  console.log(`provider: ${PROVIDER}   model: ${MODEL}   voice: ${VOICE ?? "(model default)"}\n`);
  for (const l of script) {
    console.log(`${String(l.from).padStart(5)}  ${l.id}`);
    console.log(`       ${l.text}\n`);
  }
  process.exit(0);
}

mkdirSync(VO_DIR, { recursive: true });

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const durations = existsSync(DURATIONS)
  ? JSON.parse(readFileSync(DURATIONS, "utf8"))
  : {};

// Lines that were removed from the script must not keep their old durations —
// the video would place audio for a beat that no longer exists.
for (const id of Object.keys(durations)) {
  if (!script.some((l) => l.id === id)) {
    delete durations[id];
    delete cache[id];
  }
}

let generated = 0;
let skipped = 0;

for (const line of script) {
  const out = join(VO_DIR, `${line.id}.wav`);
  const stamp = `${PROVIDER}::${MODEL}::${VOICE ?? ""}::${INSTRUCTIONS}::${line.text}`;
  const fresh =
    !FORCE && cache[line.id] === stamp && existsSync(out) && statSync(out).size > 1024;

  if (fresh) {
    durations[line.id] = wavDuration(out);
    skipped++;
    continue;
  }

  process.stdout.write(`  ${line.id} … `);
  const raw = await synthesize(line.text);
  const tmp = join(VO_DIR, `.${line.id}.raw`);
  writeFileSync(tmp, raw);
  toWav(tmp, out);
  const secs = wavDuration(out);
  durations[line.id] = secs;
  cache[line.id] = stamp;
  generated++;
  console.log(`${secs.toFixed(2)}s`);
}

writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);
writeFileSync(DURATIONS, `${JSON.stringify(durations, null, 2)}\n`);

/* ------------------------------------------------- overlap sanity check */

/**
 * Two lines that overlap are two people talking at once, and their duck
 * windows would fight. This does not fix the timing — which line moves is a
 * judgement call — but it refuses to let the problem reach a render silently.
 */
const { TOTAL, FPS, START, ACTS } = await import("./timeline-mirror.mjs");
const placed = script
  .map((l) => ({ ...l, end: l.from + Math.ceil(durations[l.id] * FPS) }))
  .sort((a, b) => a.from - b.from);

let clash = false;
for (let i = 1; i < placed.length; i++) {
  const prev = placed[i - 1];
  const cur = placed[i];
  if (cur.from < prev.end) {
    clash = true;
    console.warn(
      `  overlap: "${prev.id}" ends at ${prev.end}, "${cur.id}" starts at ${cur.from} ` +
        `(move it to ${prev.end + 10} or later)`,
    );
  }
}

// A line that runs past its own beat is describing something that has already
// cut away. Warn, but do not fail: a short spill across a cross-fade is fine.
for (const l of placed) {
  const act = ACTS.find((a) => a.id === l.id);
  if (!act) continue;
  const actEnd = START[act.id] + act.frames;
  if (l.end > actEnd + 20) {
    console.warn(
      `  spills: "${l.id}" ends at ${l.end}, its beat ends at ${actEnd}`,
    );
  }
}

const last = placed[placed.length - 1];
if (last.end > TOTAL) {
  clash = true;
  console.warn(`  overruns: "${last.id}" ends at ${last.end}, past the cut's ${TOTAL}`);
}

console.log(
  `\n${generated} generated, ${skipped} unchanged. Wrote src/vo-durations.json.` +
    (clash ? " Fix the warnings above." : ""),
);

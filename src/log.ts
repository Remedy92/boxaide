/**
 * The log file: what happened, after the process that knew is gone.
 *
 * Boxaide used to keep exactly one record of a failed agent launch, and it was
 * `launcher.lastExit` in memory. Restart the server and the only evidence that
 * a CLI exited 1 with an empty stderr was gone with it, which is why a stuck
 * chat could not be diagnosed at all: the pane said the agent was not running,
 * and nothing on disk said why.
 *
 * So this module, and its rules:
 *
 *  - Append-only, one line per event, no reader in this process. A log that
 *    something has to be running to read is the thing that was already missing.
 *  - NDJSON, because the fields are identifiers and numbers and a person
 *    greps them. `{"t":...,"level":...,"scope":...,"msg":...}` plus whatever
 *    the call site names.
 *  - Identifiers only. Never a message body, never mail content, never a tool
 *    result, never a token. What goes in are agent ids, pids, exit codes,
 *    durations, driver events, and the tail of a child's stderr. `redact`
 *    below is the backstop for that last one, which is the only field whose
 *    text comes from somewhere else.
 *  - Synchronous writes. The volume is process spawns and process exits, and a
 *    crash must not lose the line that explains it.
 *  - No dependency. The repository has no logging library and this is not a
 *    reason to add one.
 *
 * Off until configured. `configureLog` is called by the launcher with the
 * install's data directory, so a `:memory:` install and every test that builds
 * one write nothing, and nothing has to be cleaned up after them.
 */
import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

/**
 * What a call site may attach to a line.
 *
 * Scalars only, and the runtime enforces it rather than trusting the type: an
 * object reaching a log line is how a whole message, a parsed mail, or a tool
 * result ends up on disk. Anything else is written as "[unloggable]".
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Rotate once the live file is at least this big. */
const MAX_BYTES = 5 * 1024 * 1024;

/** Files kept in total: `boxaide.log`, `boxaide.log.1`, `boxaide.log.2`. */
const KEEP = 3;

/**
 * The longest a single string field may be.
 *
 * A cap, not a nicety. Every string that is not one of our own literals came
 * from a child process, and an unbounded one turns a log line into whatever
 * that child decided to print.
 */
const VALUE_LIMIT = 1024;

/**
 * Patterns whose match is a credential, replaced before the value is written.
 *
 * The list is deliberately coarse. A CLI that fails to sign in prints its own
 * diagnostics, and those diagnostics have been seen to include the header they
 * sent. Missing a shape here costs a redaction; matching too much costs
 * nothing but a less specific log line.
 */
const SECRETS: Array<[RegExp, string]> = [
  // An auth scheme and what follows it. First, because the value after
  // `Authorization:` is `Bearer <the secret>` and a rule that stopped at the
  // scheme would leave the secret standing.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
  // Anything spelled as a named credential, prefix and all, so `GITHUB_TOKEN=`
  // and `"api_key": "..."` are the same rule. An explicit `:` or `=` is
  // required: matching a bare `token expired` would redact the sentence that
  // explains the failure.
  [
    /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|credential))(["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi,
    "$1=[redacted]",
  ],
  // Provider key shapes, which carry no name beside them.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  // A JWT, which is what a copied session credential usually looks like.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]"],
];

type Sink = {
  dir: string;
  file: string;
  maxBytes: number;
  keep: number;
  /** Bytes in the live file, tracked so a line does not cost a stat. */
  size: number;
};

let sink: Sink | null = null;

/** Where this install's logs live. Beside the data directory, not inside it. */
export function logDirFor(dataDir: string): string {
  return join(dataDir, "logs");
}

/**
 * Points the log at an install, or turns it off.
 *
 * Called by whoever knows the data directory, which in the server is the agent
 * launcher: it is constructed once per process with the install's context, and
 * it is also the first thing that has anything to log. Calling it again with a
 * different directory moves the log; calling it with `:memory:` or null turns
 * writing off, which is what tests and embedded installs get.
 *
 * Never throws. A log that cannot be opened must not be what stops a server
 * from starting.
 */
export function configureLog(opts: {
  dataDir: string | null;
  maxBytes?: number;
  keep?: number;
}): void {
  if (!opts.dataDir || opts.dataDir === ":memory:") {
    sink = null;
    return;
  }
  const dir = logDirFor(opts.dataDir);
  const file = join(dir, "boxaide.log");
  try {
    // 0700: the log names what this machine runs and when, and on a shared box
    // that is nobody else's business.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    sink = null;
    return;
  }
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    // No log yet. The first write creates it.
  }
  sink = {
    dir,
    file,
    maxBytes: opts.maxBytes ?? MAX_BYTES,
    keep: opts.keep ?? KEEP,
    size,
  };
}

/** The live log file, or null when nothing is being written. */
export function logFilePath(): string | null {
  return sink?.file ?? null;
}

/**
 * One line.
 *
 * `scope` is a dotted area the reader greps for (`agent.launcher`,
 * `agent.turn`, `desktop`). `message` is a short fixed phrase, not a sentence
 * built from data: the data belongs in `fields`, where it is redacted and
 * capped.
 */
export function log(
  level: LogLevel,
  scope: string,
  message: string,
  fields: LogFields = {},
): void {
  const target = sink;
  if (!target) return;
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    msg: message,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line[key] = safeValue(value);
  }
  let text: string;
  try {
    text = `${JSON.stringify(line)}\n`;
  } catch {
    // A field that cannot be serialised is a bug at the call site, not a
    // reason to lose the event.
    text = `${JSON.stringify({ t: line.t, level, scope, msg: message, note: "unserialisable fields" })}\n`;
  }
  write(target, text);
}

export function logInfo(scope: string, message: string, fields?: LogFields): void {
  log("info", scope, message, fields);
}

export function logWarn(scope: string, message: string, fields?: LogFields): void {
  log("warn", scope, message, fields);
}

export function logError(scope: string, message: string, fields?: LogFields): void {
  log("error", scope, message, fields);
}

/**
 * A value fit to be written: scalars pass, strings are redacted and capped,
 * anything else is refused.
 */
function safeValue(value: unknown): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return redact(value);
  // An object, an array, a Buffer. Whatever it is, it is not an identifier,
  // and the point of this module is that only identifiers reach the disk.
  return "[unloggable]";
}

/**
 * Text from a child process, made fit to keep: credentials masked, length
 * capped. Exported because it is the rule the tests check, not an internal.
 */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRETS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > VALUE_LIMIT) {
    out = `${out.slice(0, VALUE_LIMIT)}...[${out.length - VALUE_LIMIT} more]`;
  }
  return out;
}

/** Appends, rotating first when the live file has reached its size. */
function write(target: Sink, text: string): void {
  try {
    if (target.size >= target.maxBytes) rotate(target);
    // The mode applies on creation only, so a file that already exists keeps
    // whatever it has. That is why `chmod` follows the first write below.
    appendFileSync(target.file, text, { mode: 0o600 });
    if (target.size === 0) {
      try {
        chmodSync(target.file, 0o600);
      } catch {
        // A filesystem without modes. The line is written either way.
      }
    }
    target.size += Buffer.byteLength(text);
  } catch {
    // A full disk, a read-only home, a directory somebody removed underneath
    // us. None of them is a reason to take the server down, and there is
    // nowhere else to report it to.
  }
}

/**
 * `boxaide.log` becomes `.1`, `.1` becomes `.2`, and the oldest goes.
 *
 * Renames rather than copies: a rename is atomic, so a reader tailing the log
 * never sees a half-written file, and the live path is free the moment it
 * returns.
 */
function rotate(target: Sink): void {
  if (target.keep < 2) {
    // Keeping one file means keeping only the live one, so there is nothing to
    // rename it to. Start it over instead of growing for ever.
    try {
      rmSync(target.file, { force: true });
      target.size = 0;
    } catch {
      // Still there. Appending to an oversized log is the safe failure.
    }
    return;
  }
  const oldest = target.keep - 1;
  try {
    rmSync(`${target.file}.${oldest}`, { force: true });
  } catch {
    // Not there, or not ours. The renames below still make room.
  }
  for (let n = oldest - 1; n >= 1; n--) {
    try {
      renameSync(`${target.file}.${n}`, `${target.file}.${n + 1}`);
    } catch {
      // That generation does not exist yet.
    }
  }
  try {
    renameSync(target.file, `${target.file}.1`);
    target.size = 0;
  } catch {
    // Nothing to rotate, or the rename failed. Keep appending: an oversized
    // log beats a lost one.
  }
}

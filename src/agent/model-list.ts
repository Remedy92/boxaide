/**
 * Model lists read from the agent CLIs themselves, instead of typed here.
 *
 * A list baked into this repo is wrong the moment a CLI ships new models, and
 * it stays wrong until someone notices — Antigravity's picker offered three
 * Gemini 2.x ids long after `agy models` had moved to the 3.x line, so every
 * pick was a model the CLI would reject. Each spec now names its own listing
 * command and a parser for that command's output.
 *
 * The output is untrusted text from a subprocess, not a constant, so every id
 * is shape-checked before it can become an argv element. `--model` is the only
 * place these land, and an id that could be read as a flag never gets there.
 */
import { spawn } from "node:child_process";

/** A model the user may pick for an agent. */
export type ModelOption = { id: string; label: string };

/**
 * How one CLI reports its models: the subcommand to run, and the parser for
 * what it prints. Parsers read stdout and stderr joined — `agy` writes its
 * progress line to stderr and the list to stdout, and other CLIs may differ.
 */
export type ModelLister = {
  args: string[];
  parse: (output: string) => ModelOption[];
};

/**
 * Ids that may reach a command line. No leading dash (an id must never be
 * read as a flag), no whitespace, no shell metacharacters — even though spawn
 * takes an argv array and never a shell.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

/** A model list is small; anything past this is a CLI printing something else. */
const MAX_MODELS = 500;

/** These CLIs reach the network to list, so the wait is real but bounded. */
export const MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * Runs a CLI's listing command and returns what it offers.
 *
 * Null means "could not ask" — not installed, timed out, crashed, or printed
 * nothing usable. Callers distinguish that from an empty list, because an
 * agent whose list failed should not look like an agent with no models.
 */
export async function fetchModels(
  bin: string,
  lister: ModelLister,
  env: NodeJS.ProcessEnv,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<ModelOption[] | null> {
  const output = await runCapture(bin, lister.args, env, timeoutMs);
  if (output === null) return null;
  const parsed = sanitize(lister.parse(output));
  return parsed.length > 0 ? parsed : null;
}

/** Drops malformed ids and duplicates, and caps the list. */
function sanitize(options: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const opt of options) {
    const id = opt.id.trim();
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: (opt.label || id).trim().slice(0, 120) });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function runCapture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // stdin is ignored so a CLI that would prompt gets EOF and exits rather
      // than waiting out the timeout.
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const capture = (chunk: string) => {
      out = (out + chunk).slice(0, 256 * 1024);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", capture);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", capture);

    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    // The timer must not hold the process open when nothing else is pending.
    timer.unref?.();

    child.on("error", () => finish(null));
    // Some CLIs print the list and then exit non-zero on an unrelated warning,
    // so the output is parsed either way; a truly failed run parses to nothing.
    child.on("close", () => finish(out));
  });
}

/* -------------------------------------------------------------------------- */
/* per-CLI parsers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `agy models`: one "id<TAB>Label" per line, after a progress line on stderr.
 */
export function parseTabbedModels(output: string): ModelOption[] {
  const out: ModelOption[] = [];
  for (const line of output.split("\n")) {
    const [id, ...rest] = line.trim().split("\t");
    if (!id || rest.length === 0) continue;
    out.push({ id, label: rest.join(" ").trim() || id });
  }
  return out;
}

/**
 * `opencode models`: one bare "provider/model" id per line, no labels. The
 * label shown is the id, because the provider prefix is the part that tells
 * two same-named models apart.
 */
export function parseBareModels(output: string): ModelOption[] {
  const out: ModelOption[] = [];
  for (const line of output.split("\n")) {
    const id = line.trim();
    if (!id || !id.includes("/")) continue;
    out.push({ id, label: id });
  }
  return out;
}

/**
 * `grok models`: prose with the models as a bullet list, the current one
 * marked "*" and tagged "(default)".
 *
 *   Available models:
 *     * grok-4.6 (default)
 *     - grok-4.5
 *
 * Only bullets under that header count. A bare bullet is no evidence of a
 * model — a CLI that cannot list prints prose with bullets of its own
 * ("- run `grok login` first"), and reading those as ids fills the picker
 * with words that then reach --model.
 */
export function parseBulletModels(output: string): ModelOption[] {
  const out: ModelOption[] = [];
  let inList = false;
  for (const line of output.split("\n")) {
    if (/^\s*available models:/i.test(line)) {
      inList = true;
      continue;
    }
    const match = /^\s*[*-]\s+(\S+)(.*)$/.exec(line);
    if (!match) {
      // The list runs to the first line that is neither a bullet nor blank.
      if (inList && line.trim() !== "") inList = false;
      continue;
    }
    if (!inList) continue;
    const id = match[1];
    const isDefault = /\(default\)/.test(match[2]);
    out.push({ id, label: isDefault ? `${id} (default)` : id });
  }
  return out;
}

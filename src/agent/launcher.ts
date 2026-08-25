/**
 * Local agent launcher: Boxaide starts the agent, instead of waiting for one.
 *
 * MCP is client-driven, so the Agent view is silent until some client enters
 * the chat_await_message loop. For GUI clients (Claude Desktop) nothing can
 * automate that. For CLI agents there is no such wall: they run headless and
 * take their MCP servers from the command line or an isolated config home. This
 * module detects which known agent CLIs are installed, and starts exactly one
 * of them wired to this server.
 *
 * Two launch shapes, and the difference is who owns the loop:
 *  - A KICKOFF launch (Grok, Codex) is one long-lived child, and the loop
 *    exists because the prompt tells the model to keep calling
 *    chat_await_message. That loop is a suggestion, and it ends when the model
 *    decides it has finished.
 *  - A driven launch (Claude Code, Antigravity) hands the loop to a driver in
 *    this process. See driver.ts. `spec.drive` builds it. There is no
 *    long-lived child: the driver spawns one process per turn.
 *
 * Security posture, decided by the user and enforced here:
 *  - Only binaries from the fixed registry in ./registry.ts are ever spawned,
 *    resolved from PATH, with argv built entirely by the spec modules in
 *    ./clis/. No request input reaches a command line.
 *  - Every launch carries a scoped credential, not the master bearer, and the
 *    MCP server refuses anything outside that scope. See src/mcp/scope.ts.
 *    Sending mail and creating meetings are outside every agent scope. Each
 *    spec's per-tool flags (Claude's --allowedTools, Grok's --allow) mirror
 *    the same scope onto the CLIs that offer them, so a refusal happens early
 *    where it can; the CLIs that offer no such flag are launchable anyway,
 *    because the wall no longer lives in the client.
 *  - One CHAT agent at a time. The channel hands each user message to exactly
 *    one waiter; a second launched chat agent would race it for every message.
 *    Automation runs are separate and may overlap. See `runOnce` and
 *    docs/specs/agent-platform.md invariant 4.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { agentRoot, agentWorkDir } from "./paths.js";
import { capabilityOf, type AgentCapability } from "./capability.js";
import { isAgyAuthPrompt, lineSplitter, type RenderRunLine } from "./agent-stream.js";
import type { AgentDriver, StopCause } from "./driver.js";
import {
  allowedHostsFor,
  egressDisabled,
  EgressProxy,
  egressEnv,
} from "./egress.js";
import { runMemoryBlock } from "./memory-context.js";
import { configureLog, logError, logInfo } from "../log.js";
import { memoryDir } from "../memory/store.js";
import { fetchModels, type ModelOption } from "./model-list.js";
import type { ScopeProfile } from "../mcp/scope.js";
import {
  confineCommand,
  type NetworkAccess,
  plainCommand,
  resolveAccess,
  type AgentAccess,
  type LaunchCommand,
} from "./sandbox.js";
import type { ScopedGrant } from "../mcp/scoped-tokens.js";
import { KNOWN_AGENTS } from "./registry.js";
import { claudeConfigHomeFor } from "./clis/claude.js";
import { AUTOMATION_RUN_PREAMBLE, type AgentSpec, type LaunchContext } from "./spec.js";

// The launcher stays the import path for everything it used to define. The
// per-CLI modules and ./spec.js are where the code lives now.
export { KNOWN_AGENTS };
export { AUTOMATION_RUN_PREAMBLE };
export type { AgentSpec, LaunchContext };
export { KICKOFF, runPreapprovedToolNames, type DriveOptions } from "./spec.js";
export {
  claudeTurnArgs,
  claudeCopyCredentials,
  claudeHealCredentials,
} from "./clis/claude.js";
export type { AgentCapability } from "./capability.js";
export type { ModelOption } from "./model-list.js";

/**
 * Where agent CLIs actually live, beyond PATH.
 *
 * A macOS app launched from Finder inherits launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) rather than the login shell's. Every agent CLI on a
 * real machine lives outside that (Homebrew, ~/.local/bin, per-tool bins), so
 * detection that only reads PATH finds nothing exactly when Boxaide runs as
 * the app instead of from a terminal.
 */
function wellKnownBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".bun", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".codex", "bin"),
    join(home, ".gemini", "antigravity-cli", "bin"),
    join(home, ".gemini", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * The agent-owned subtree, `agentRoot`/`agentWorkDir` and why it sits
 * outside the data directory, is defined in ./paths.ts and shared with the
 * modules that reason about the same layout.
 */

/** Where every automation run's own directory is created. */
function runWorkDirRoot(ctx: LaunchContext): string {
  return join(agentWorkDir(ctx.dataDir), "runs");
}

/**
 * One directory per automation run, named for the run.
 *
 * Runs may overlap, and an agent is free to write files where it is standing.
 * Sharing one directory means two runs can overwrite each other's scratch
 * files, silently and with no way to tell afterwards. It also holds each run's
 * MCP config and, for Grok, its whole config home.
 *
 * Removed when the run finishes, and swept at startup for the ones a crash
 * left behind.
 */
function runWorkDir(ctx: LaunchContext, runId: string): string {
  return join(runWorkDirRoot(ctx), runId);
}


/**
 * A spec whose whole launch is its driver: no argv, so nothing is spawned here
 * and the driver's lifetime is the agent's.
 */
function drivenOnly(spec: AgentSpec): boolean {
  return spec.args === undefined && spec.drive !== undefined;
}

/**
 * One agent as the UI sees it: what it can do here, and why not when it
 * cannot. Every field but `models` comes from `capabilityOf`, so the picker,
 * the chat launch and the run resolver cannot disagree about the same agent.
 */
export type ListedAgent = AgentCapability & {
  id: string;
  label: string;
  /** Models the user may pick from. Empty means no picker. */
  models: ModelOption[];
};

export type RunningAgent = {
  id: string;
  pid: number;
  startedAt: string;
  /** The picked model id, or null for the CLI's own default. */
  model: string | null;
  /** What this launch was actually given, not what was asked for. */
  access: AgentAccess;
  /**
   * Why it is not confined, when it is not. Null on a confined launch. The UI
   * shows this verbatim: an unconfined agent that looks confined is worse than
   * one that says so.
   */
  accessNotice: string | null;
};

/**
 * Why a launch ended.
 *
 * The exit code cannot answer this. A driven agent has no process exit to report
 * at all, and a long-lived child that was asked to stop exits on a signal with
 * code null, so a UI reading the code alone painted "Stop" as a crash on one
 * CLI and a clean stop on another. The launcher is the only place that knows
 * which of the two happened, because it is the thing that was asked.
 */
export type ExitReason =
  /** The user (or shutdown) asked for it. */
  | "stopped"
  /** It failed: a driver gave up, or the CLI could not be spawned. */
  | "error"
  /** It ended by itself. The code says whether that was clean. */
  | "exited";

export type LastExit = {
  id: string;
  /** Null when there was no process exit to read, or it died on a signal. */
  code: number | null;
  reason: ExitReason;
  at: string;
  /** Last few KB of stderr, for the UI to explain a crash. */
  stderrTail: string;
  /**
   * The CLI has no sign-in, so nothing will run on it until a login lands.
   *
   * Its own field rather than a phrase the UI greps for out of `stderrTail`:
   * this is the one exit a user can fix in one click, and a pane that offered
   * that click on a string match would stop offering it the day the CLI
   * reworded its notice. False for every other ending, including a stop.
   */
  authRequired: boolean;
};

const STDERR_TAIL_LIMIT = 4_096;

/**
 * How long a CLI's model list is trusted. Long enough that the Agent pane's
 * polling does not respawn the CLIs, short enough that a CLI update shows up
 * without restarting Boxaide.
 */
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** A listing that failed is retried on the next poll, not in ten minutes. */
const MODEL_CACHE_FAILURE_TTL_MS = 30 * 1000;

/**
 * How long the first, uncached `list()` waits for the CLIs before answering
 * with an empty picker. Well under the listing timeout, because the same
 * response carries the running/exited state that the pane polls for.
 */
const MODEL_LIST_FIRST_WAIT_MS = 2_000;

/** What a finished one-shot automation run reports back to the scheduler. */
export type OneShotResult = {
  status: "ok" | "error" | "killed";
  /** Null when the process was signalled (including the timeout SIGKILL). */
  exitCode: number | null;
  /** stdout and stderr interleaved, tail-capped at ONESHOT_LOG_LIMIT. */
  log: string;
  /**
   * The registry id that actually ran: the saved one, or the first available
   * when the automation named none. The log carries the same answer, but only
   * readers who get the whole log see it, and readers get the tail.
   */
  agentId: string;
};

export type OneShotOptions = {
  /**
   * The run row's id. Identifies this run among the ones alive beside it, and
   * names the directory it works in, so it must be a plain id: letters,
   * digits, dash, underscore.
   */
  runId: string;
  /** AgentSpec id, or null/undefined for the first launchable installed CLI. */
  agentId?: string | null;
  /** The automation prompt. The run preamble is prepended here, not by callers. */
  prompt: string;
  /**
   * Model id for that CLI, or null/undefined for its own default. Validated
   * against what the CLI itself offers, exactly as `start` does: the id becomes
   * an argv element, so nothing unvetted may reach a command line.
   */
  model?: string | null;
  /** Overridable for tests only; production runs use ONESHOT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Tests only; production runs use ONESHOT_FIRST_OUTPUT_TIMEOUT_MS. */
  firstOutputTimeoutMs?: number;
  /** Tests only; production runs use ONESHOT_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
};

/** Spec: 15-minute hard timeout, then SIGKILL and status 'killed'. */
export const ONESHOT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * How many automation runs may be alive at once (spec invariant 4). The chat
 * agent is not one of them and never waits behind them.
 *
 * Two by default, not one, so a slow run stops holding up the whole schedule.
 * Not more by default because every run is a full CLI process with a model
 * session behind it: N runs is N times the spend in the same window and N times
 * the pressure on the provider's own rate limit, and a 429 reaches the user as
 * a failed run with an opaque log.
 */
export const DEFAULT_RUN_CONCURRENCY = 2;

/**
 * The ceiling on that, whatever the environment asks for. Above this the
 * failure modes are untested and the first symptom would be rate-limit errors
 * the user cannot act on.
 */
export const MAX_RUN_CONCURRENCY = 4;

/**
 * Reads BOXAIDE_AGENT_CONCURRENCY, clamped. Anything unparseable is the
 * default: a typo in an environment variable must not silently serialize the
 * schedule, nor uncap it.
 */
export function runConcurrencyFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.BOXAIDE_AGENT_CONCURRENCY;
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_RUN_CONCURRENCY;
  }
  return Math.min(parsed, MAX_RUN_CONCURRENCY);
}

/**
 * How long a streaming run may stay silent at start before it is written off.
 *
 * Armed only for specs with `renderRunLine`, a spec whose runArgs asked its
 * CLI for an event stream. A healthy Claude session prints its start line
 * within seconds, so no stdout at all for this long is a wedged startup.
 * First stdout disarms the timer: a run that is quiet mid-tool is healthy,
 * and a wedge after that waits for the deadline. A non-streaming CLI prints
 * nothing until it finishes, and the same timer would kill healthy runs;
 * those keep only the deadline.
 */
export const ONESHOT_FIRST_OUTPUT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * How long a finish waits for stdio EOF after the child itself is gone.
 *
 * 'close' is the honest end of a run, but it waits for every pipe to close and
 * a detached grandchild can hold one open for as long as it likes, and that is
 * what turned a 15-minute timeout into a 17-minute run.
 */
export const ONESHOT_CLOSE_GRACE_MS = 2_000;

/**
 * How old a run directory must be before a starting process removes it. The
 * deadline plus a margin, so a run still inside its own 15 minutes is never
 * swept. Mirrors RUN_STALE_MS in src/automation/store.ts, which decides the
 * same question about the run's database row.
 */
export const RUN_WORKDIR_STALE_MS = ONESHOT_TIMEOUT_MS + 5 * 60 * 1000;

/**
 * Notes appended to a run log so the log is never empty. A killed run's log is
 * the only thing a human gets, and "wrote nothing" explains nothing.
 * Style-matched to STALE_RUN_NOTE in src/automation/store.ts.
 */
export function oneShotDeadlineNote(ms: number): string {
  return `[boxaide] killed: the run hit the ${windowAdjective(ms)} limit and was stopped.`;
}

export function oneShotSilentNote(ms: number): string {
  return `[boxaide] stopped: the agent wrote no output for ${windowDuration(ms)}, so the run was ended early instead of held to the deadline.`;
}

/**
 * The window a note states, in the unit that is honest for it. Whole minutes
 * read as minutes; anything else as seconds to one decimal, so a test's 200ms
 * override does not render as a rounded-off "0 seconds".
 */
function windowParts(ms: number): { amount: number; unit: "minute" | "second" } {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes)) return { amount: minutes, unit: "minute" };
  return { amount: Math.round(ms / 100) / 10, unit: "second" };
}

/** Before a noun: "15-minute limit". */
function windowAdjective(ms: number): string {
  const { amount, unit } = windowParts(ms);
  return `${amount}-${unit}`;
}

/** After a preposition: "for 15 minutes". */
function windowDuration(ms: number): string {
  const { amount, unit } = windowParts(ms);
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

export const ONESHOT_KILLED_NOTE =
  "[boxaide] killed: the run was stopped before it finished.";

export function isPlaywrightBootstrapHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower.includes("playwright");
}

/**
 * What a confined run's refused connections read as in its log.
 *
 * Two audiences, one line. For a person whose automation broke, it names the
 * host their CLI wanted so BOXAIDE_RUN_NETWORK_ALLOW can answer it. For a
 * person reading a run that worked, it is the record that something in there
 * tried to reach an address nobody listed.
 */
export function egressRefusedNote(
  hosts: readonly string[],
  total = hosts.length,
): string {
  const extra = total > hosts.length ? ` (and ${total - hosts.length} more)` : "";
  const hasPlaywright = hosts.some(isPlaywrightBootstrapHost);
  const playwrightClarification = hasPlaywright
    ? " (refused Playwright CDN domains are an optional upstream Antigravity browser-bootstrap attempt, not the automation task asking to browse)"
    : "";
  return `[boxaide] network: refused ${hosts.join(", ")}${extra}${playwrightClarification}. A scheduled run reaches its model provider and Boxaide, nothing else. Add a host with BOXAIDE_RUN_NETWORK_ALLOW if the CLI needs it.`;
}

/**
 * Written into a confined run's log before the CLI says anything.
 *
 * Refusals are only recorded for connections that came through the proxy. A
 * CLI that ignores the proxy variables goes straight at the network, is
 * refused by the sandbox instead, and reports whatever a connection error
 * looks like to it, with nothing of ours in the log to explain it. So the
 * boundary announces itself at the top of every run it applies to: the person
 * reading a broken automation is then one line away from the reason, whether
 * or not this proxy ever saw the attempt.
 */
export function egressActiveNote(hosts: readonly string[]): string {
  return `[boxaide] network: this run reaches ${hosts.length > 0 ? hosts.join(", ") : "no external host"} and Boxaide, nothing else. A connection error naming another host is this boundary. BOXAIDE_RUN_NETWORK_ALLOW adds one; BOXAIDE_RUN_NETWORK=open turns it off.`;
}

/**
 * The tail is what gets kept, not the head: a run that failed says why in its
 * last lines, and the interesting part of a run that succeeded is the summary
 * it prints at the end.
 */
const ONESHOT_LOG_LIMIT = 64 * 1024;

export class AgentLauncher {
  private child: ChildProcess | null = null;
  private running: RunningAgent | null = null;
  private lastExit: LastExit | null = null;
  /** Per-agent, the model its last chat launch was given. See lastModelFor. */
  private lastModels = new Map<string, string | null>();
  private stderrTail = "";
  /**
   * The in-flight automation runs, keyed by run id. Separate from
   * `child`/`running`, which stay the interactive chat agent's state: the Agent
   * pane's presence, the /api/agents status, and stop() must not start
   * reporting on a scheduled run that the user never pressed Start on.
   *
   * A map, not a single child, because runs may overlap up to `runLimit`. Each
   * entry carries its own kill so one run can be stopped without touching its
   * siblings.
   */
  private oneShots = new Map<string, { child: ChildProcess; kill: () => void }>();
  /**
   * Runs that hold a slot but have no child yet.
   *
   * Validating a picked model may have to ask the CLI what it offers, and that
   * await sits between the scheduler's claim of the run row and the spawn. A
   * slot counted only once the child exists would let a second run through that
   * window and put two more runs on a launcher with room for one.
   *
   * Chat is no longer part of this. It has its own slot, so a chat launch in
   * the window can no longer cost a run the fire it already claimed.
   */
  private starting = new Set<string>();
  /** The in-process loop driving the chat agent, for specs that have one. */
  private driver: AgentDriver | null = null;
  /**
   * The chat launch's scoped credential. Null when nothing is running, or when
   * this launcher was built without a minter.
   */
  private chatGrant: ScopedGrant | null = null;
  /**
   * A stop was asked for on the current launch. It is the only thing that
   * separates "the user pressed Stop" from "it died" once the exit arrives: a
   * signalled child reports code null either way.
   */
  private stopRequested = false;
  /** Per-agent model lists as their CLI last reported them. */
  private modelCache = new Map<
    string,
    {
      models: ModelOption[];
      /** The CLI has answered at least once. An empty list is an answer. */
      answered: boolean;
      expiresAt: number;
      inFlight?: Promise<ModelOption[]>;
    }
  >();
  /** Bumped by refreshModels(), so a fetch it invalidated cannot land. */
  private modelGeneration = 0;
  /**
   * close() has run. Checked before every spawn, including after the one await
   * in start(): close() clears `running`, so a start suspended on the model
   * lookup would otherwise find the chat slot free and spawn an agent nobody
   * owns, moments after shutdown killed everything else.
   */
  private closed = false;

  /** How many automation runs may overlap. See runConcurrencyFrom. */
  private readonly limit: number;

  constructor(
    private ctx: LaunchContext,
    private registry: AgentSpec[] = KNOWN_AGENTS,
    private env: NodeJS.ProcessEnv = process.env,
    private extraBinDirs: string[] = wellKnownBinDirs(),
    runLimit?: number,
  ) {
    this.limit = runLimit ?? runConcurrencyFrom(env);
    // The log is pointed at this install here because this is the first object
    // in the process that both knows the data directory and has something
    // worth writing. A `:memory:` install turns it off, which is what every
    // test that builds one gets. See src/log.ts.
    configureLog({ dataDir: this.ctx.dataDir });
    // A crash mid-run leaves its directory behind, and nothing else removes
    // one. Swept at construction, the same moment AutomationScheduler sweeps
    // the run rows a dead process left 'running'.
    this.sweepRunWorkDirs();
  }

  /**
   * Removes run directories old enough that no live run can own them.
   *
   * Age is the test, not "this process owns none yet": a second Boxaide over
   * the same data directory may have a run in flight right now, and deleting
   * the directory out from under it would break a healthy run. Same reasoning,
   * and the same window, as AutomationStore.sweepStaleRuns.
   */
  private sweepRunWorkDirs(now: number = Date.now()): void {
    const root = runWorkDirRoot(this.ctx);
    const cutoff = now - RUN_WORKDIR_STALE_MS;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // No runs have ever happened here.
      return;
    }
    for (const entry of entries) {
      const path = join(root, entry);
      try {
        if (statSync(path).mtimeMs > cutoff) continue;
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours to remove. Wasted disk is not a reason to
        // refuse to start.
      }
    }
  }

  /**
   * The registry, with each agent's models as its own CLI reports them.
   *
   * The very first call has nothing cached and waits for the CLIs, so the
   * picker is right the moment the pane opens. Every later call answers from
   * cache and refreshes in the background. This endpoint is polled every few
   * seconds for the running/exited state, and that must never wait on a
   * subprocess. A CLI that fails to list falls back to its typed `models`, or
   * to an empty picker.
   */
  async list(): Promise<ListedAgent[]> {
    return Promise.all(
      this.registry.map(async (spec) => {
        const bin = this.resolveBin(spec.bin);
        const cached = this.cachedModels(spec, bin);
        return {
          id: spec.id,
          label: spec.label,
          ...capabilityOf(spec, bin, this.ctx, this.env),
          models: cached ?? (await this.firstModels(spec, bin)),
        };
      }),
    );
  }

  /**
   * The cold-cache wait, capped. Waiting is what makes the picker right on the
   * first poll, but this response also carries the running/exited state, and a
   * CLI that hangs must not hold that back for the whole listing timeout. Past
   * the cap the poll answers with an empty picker and the fetch keeps running;
   * it lands in the cache and the next poll shows it.
   */
  private async firstModels(
    spec: AgentSpec,
    bin: string | null,
  ): Promise<ModelOption[]> {
    // A listing that throws must not fail the endpoint. It is the same
    // "could not ask" as a CLI that exits non-zero.
    const fetched = this.modelsFor(spec, bin).catch(() => null);
    const capped = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), MODEL_LIST_FIRST_WAIT_MS);
      timer.unref?.();
    });
    return (await Promise.race([fetched, capped])) ?? [];
  }

  /**
   * Discards every cached model list, so the next `list()` asks the CLIs
   * again. Reached by `GET /api/agents?refresh=1`, which is how a user who
   * just updated a CLI sees its new models without waiting out the TTL.
   */
  refreshModels(): void {
    this.modelCache.clear();
    // Any fetch already running belongs to the state just discarded, so its
    // answer must not land on top of the cleared cache.
    this.modelGeneration++;
  }

  /**
   * The list as last read, without waiting. Null means nothing has been read
   * yet for this agent. A stale entry is returned and a refresh started, so a
   * poll answers now and is correct on the next one.
   */
  private cachedModels(
    spec: AgentSpec,
    bin: string | null,
  ): ModelOption[] | null {
    if (!spec.listModels || bin === null) return spec.models ?? [];
    const hit = this.modelCache.get(spec.id);
    // `answered` is what separates "never asked" from "asked, got nothing":
    // an empty list is a real answer. Reading emptiness as never-asked made
    // every poll after a failed listing wait out the fetch timeout.
    if (!hit?.answered) return null;
    if (!hit.inFlight && Date.now() >= hit.expiresAt) {
      // Nobody awaits this one, so it must swallow its own failure: an
      // unhandled rejection here takes the process down.
      void this.modelsFor(spec, bin).catch(() => {});
    }
    return hit.models;
  }

  /**
   * What this agent may be launched with, asking the CLI when the cache is
   * cold or stale. While a fetch is in flight, concurrent callers await the
   * same promise instead of spawning their own copy of the CLI. A failed
   * fetch is cached too, briefly, so a broken or offline CLI is not re-run on
   * every poll.
   */
  private async modelsFor(
    spec: AgentSpec,
    bin: string | null,
  ): Promise<ModelOption[]> {
    if (!spec.listModels || bin === null) return spec.models ?? [];
    const hit = this.modelCache.get(spec.id);
    if (hit?.inFlight) return hit.inFlight;
    if (hit?.answered && Date.now() < hit.expiresAt) return hit.models;

    // Each refresh carries the generation it was started in. A refreshModels()
    // during the fetch bumps the counter, and this answer is then dropped
    // instead of landing on top of the cleared cache with a fresh TTL.
    const generation = this.modelGeneration;
    // What the picker is showing right now. A refresh that fails must not
    // erase it: the ids in it were good a moment ago, and dropping to the
    // typed list means an empty picker for every CLI that has no typed list.
    const lastGood = hit?.answered && hit.models.length > 0 ? hit.models : null;
    const inFlight = fetchModels(
      bin,
      spec.listModels,
      // The spec's own child env, so the listing describes the environment the
      // agent is actually launched in: OpenCode and Grok both run under an
      // isolated config home, and a list read from the user's own config can
      // name providers that the launch cannot resolve. The prepare step runs
      // first, because that env names config files the CLI is told to read and
      // on a machine that has never launched this agent they do not exist yet.
      this.childEnvFor(spec, this.listWorkDir(spec)),
    )
      // Never rejects: a listing that throws is the same "could not ask" as a
      // CLI that exits non-zero. A rejected promise parked in the cache as
      // `inFlight` would fail every later list() and start() for good.
      .catch(() => null)
      .then((fetched) => {
        const models = fetched ?? lastGood ?? spec.models ?? [];
        if (generation !== this.modelGeneration) return models;
        this.modelCache.set(spec.id, {
          models,
          answered: true,
          // A failed listing expires fast, so a CLI that was mid-login or
          // offline is retried soon instead of showing nothing for ten minutes.
          expiresAt:
            Date.now() +
            (fetched ? MODEL_CACHE_TTL_MS : MODEL_CACHE_FAILURE_TTL_MS),
        });
        return models;
      });
    this.modelCache.set(spec.id, {
      models: hit?.models ?? [],
      // Carried over: a refresh on top of an earlier answer keeps serving that
      // answer, so a poll never waits on the CLI once the picker is filled.
      answered: hit?.answered ?? false,
      expiresAt: 0,
      inFlight,
    });
    return inFlight;
  }

  /**
   * Refuses unless the chat slot is free. Called before a launch and again
   * after any await that precedes the spawn. `this.running` is only
   * trustworthy for as long as the call does not yield.
   *
   * An automation run no longer blocks this. The chat agent has its own slot:
   * pressing Start must not fail because the schedule happens to be busy, which
   * is the whole point of splitting the two.
   */
  /** Refuses once close() has run. Nothing may spawn after shutdown. */
  private assertClosed(): void {
    if (this.closed) throw new LaunchError(409, "the launcher is shut down");
  }

  private assertIdle(): void {
    const running = this.running;
    if (running) {
      throw new LaunchError(409, `${running.id} is already running`);
    }

  }

  status(): { running: RunningAgent | null; lastExit: LastExit | null } {
    return { running: this.running, lastExit: this.lastExit };
  }

  /**
   * The binary this launcher would spawn for a registry id, or null when the
   * CLI is not installed.
   *
   * Exposed for the sign-in route, which has to run the SAME `claude` the
   * launches use: a machine with two of them installed would otherwise send the
   * user to log in to the one Boxaide never starts, and the sign-in would look
   * like it silently failed.
   */
  binFor(id: string): string | null {
    const spec = this.registry.find((s) => s.id === id);
    return spec ? this.resolveBin(spec.bin) : null;
  }

  /**
   * The isolated home a Claude Code launch reads its config and login from.
   *
   * Exposed for the sign-in route, and for the same reason as binFor: the
   * login has to land where the launches look. On macOS the CLI keys its
   * keychain entry to the config directory, so a `claude /login` run against
   * the user's own home produces a login no launch can see, and the sign-in
   * button then "works" every time and fixes nothing.
   */
  claudeConfigHome(): string {
    return claudeConfigHomeFor(this.ctx);
  }

  /**
   * The model the last chat launch of this agent used, or null for the CLI's
   * own default. Kept past the exit so a relaunch the user did not press Start
   * for, the one after a sign-in lands, restores what they had picked.
   */
  lastModelFor(id: string): string | null {
    return this.lastModels.get(id) ?? null;
  }

  /**
   * How many more automation runs this launcher will accept right now. The
   * scheduler asks before dequeuing (spec invariant 4).
   *
   * The chat agent is deliberately absent from this sum. It used to consume the
   * only slot, so a chat session lasting hours stopped every scheduled run
   * behind it.
   */
  runCapacity(): number {
    // Reservations count: a run between its claim and its spawn owns a slot
    // just as much as one with a child.
    return Math.max(0, this.limit - this.oneShots.size - this.starting.size);
  }

  /**
   * The absolute cap. What the database claim compares its count of live runs
   * against, since that count spans every process over this data directory.
   */
  runLimit(): number {
    return this.limit;
  }

  /** True while a chat agent is alive. Not affected by automation runs. */
  chatBusy(): boolean {
    return this.running !== null;
  }

  /**
   * Throws with a message fit for the API response.
   *
   * Async because validating the picked model may have to ask the CLI what it
   * offers; that answer is normally already cached by the list() the UI ran to
   * draw the picker.
   */
  async start(id: string, model?: string): Promise<RunningAgent> {
    this.assertClosed();
    this.assertIdle();
    const spec = this.registry.find((s) => s.id === id);
    if (!spec) throw new LaunchError(404, `unknown agent: ${id}`);
    const found = this.resolveBin(spec.bin);
    // One question, one answer, the same one the picker was drawn from.
    const chat = capabilityOf(spec, found, this.ctx, this.env).chat;
    if (!chat.ok) throw new LaunchError(400, chat.reason!);
    // A missing binary is one of the reasons `chat` carries, so chat.ok
    // implies capabilityOf found one.
    const bin = found!;
    // A driven-only launch IS its driver, and a driver with no channel declines.
    // Refuse here rather than report a running agent that does nothing.
    if (drivenOnly(spec) && !this.ctx.channel) {
      throw new LaunchError(400, `${spec.label} needs the Boxaide conversation`);
    }
    // The model id becomes an argv element, so it must be one the CLI itself
    // named, the same allowlist rule that protects the agent id, now sourced
    // from the CLI instead of from a constant in this file.
    if (model !== undefined) {
      const offered = await this.modelsFor(spec, bin);
      if (!offered.some((m) => m.id === model)) {
        throw new LaunchError(400, `${spec.label} does not offer that model`);
      }
      // That await is the only suspension point between the guard at the top
      // and the spawn below, and it reopens what that guard closed: two
      // starts racing here would both spawn, and the first child would be
      // orphaned by the second overwriting this.child. A close() landing in the
      // same window is the other way this launch could become an orphan.
      this.assertClosed();
      this.assertIdle();
    }

    // A driven spec's model does not run the chat loop, its driver does, so
    // it must not be able to take a message off the channel. That is the whole
    // difference between the two scopes, and it is decided here, from the spec,
    // rather than trusted to the CLI's own flags.
    const profile: ScopeProfile = spec.drive ? "driven" : "chat";
    // Not a parameter any more. Whoever pressed Start is not the right person
    // to be asked which of their files an agent CLI reads, and the answer they
    // could give that was not `workspace` is the one where the agent reads the
    // master credential. See resolveAccess.
    const decided = resolveAccess(this.ctx.access ?? "workspace");
    const granted = decided.access;
    const { ctx, grant } = this.launchCtx(profile, `chat:${spec.id}`);
    let workDir: string;
    try {
      workDir = this.prepareWorkDir(spec, ctx);
    } catch (err) {
      // The credential was minted before the directory existed. A launch that
      // never spawned must not leave a live one behind.
      grant?.revoke();
      throw err;
    }

    this.stderrTail = "";
    // Built once and shared with the driver: a spec's childEnv may mint a
    // per-launch secret, and the driver must see the exact value the child got.
    const childEnv = spec.childEnv?.(ctx, workDir) ?? {};
    const env = this.baseEnvWith(childEnv);
    // Built before the spawn and before the driver, because both use it and a
    // refused confinement must stop the launch rather than half-start it.
    let command: LaunchCommand;
    try {
      command = this.confine(spec, bin, workDir, granted);
    } catch (err) {
      grant?.revoke();
      throw new LaunchError(400, err instanceof Error ? err.message : String(err));
    }
    // Null for a driven-only spec: its driver spawns one child per turn, and a
    // second long-lived process here would be an agent nobody prompts.
    const child = spec.args
      ? spawn(command.bin, [...command.prefix, ...spec.args(ctx, model)], {
          cwd: workDir,
          env,
          // stdout is piped for the event stream, and MUST be consumed: a pipe
          // nobody reads fills its buffer and blocks the agent mid-write. The
          // handler below reads every chunk whether or not anything wants it.
          stdio: ["ignore", "pipe", "pipe"],
        })
      : null;
    if (child) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on(
        "data",
        lineSplitter((line) => {
          // Every line is liveness; only some carry a tool name. A spec with no
          // reader still reports the line, so its agent stays visibly alive.
          this.ctx.onActivity?.(spec.readEvent?.(line) ?? null);
        }),
      );
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
      child.on("error", (err) => {
        // Spawn failures (ENOENT, EACCES) surface as an exit, not an exception.
        this.stderrTail = `${this.stderrTail}\n${err.message}`.trim();
        this.noteExit(spec.id, { code: null, reason: "error" });
      });
      // "close", not "exit": exit fires while stderr may still hold undrained
      // data (observed on Linux), and the tail is the whole point of capturing.
      child.on("close", (code) =>
        this.noteExit(spec.id, {
          code,
          reason: this.stopRequested ? "stopped" : "exited",
        }),
      );
    }

    const started: RunningAgent = {
      id: spec.id,
      // -1 for a driven-only launch. There is no one process to name: the loop
      // is in this one, and each turn's child outlives only that turn.
      pid: child?.pid ?? -1,
      startedAt: new Date().toISOString(),
      model: model ?? null,
      access: granted,
      accessNotice: decided.notice,
    };

    logInfo("agent.launcher", "chat launch", {
      agent: spec.id,
      pid: started.pid,
      driven: spec.drive !== undefined,
      model: model ?? null,
      access: granted,
    });

    this.child = child;
    this.running = started;
    this.lastModels.set(spec.id, model ?? null);
    // Held so every path that ends this launch (a child exit, a driver giving
    // up, Stop, shutdown) takes the credential back. noteExit is the one
    // place that does it, because it is the one place they all reach.
    this.chatGrant = grant;
    this.stopRequested = false;
    // Before the driver: the channel has to know a launched agent exists, or
    // the loop's first awaitUserTurn is stamped against nobody.
    this.ctx.onRunningChange?.(spec.id);
    try {
      this.driver =
        spec.drive?.(ctx, {
          child,
          bin,
          command,
          workDir,
          model,
          env,
          childEnv,
          parentEnv: this.env,
          onStop: (error, cause) => this.noteDriverStop(spec.id, error, cause),
        }) ?? null;
    } catch (err) {
      // A launch whose loop never started is not a running agent. Without this
      // `running` would stay true with nothing driving it: every later start
      // would 409, busy() would block the scheduler, and only restarting the app
      // would clear it.
      const message = err instanceof Error ? err.message : String(err);
      this.stderrTail = `${this.stderrTail}\n${message}`.trim();
      child?.kill("SIGTERM");
      this.noteExit(spec.id, { code: null, reason: "error" });
      throw new LaunchError(400, `${spec.label} could not start its loop: ${message}`);
    }
    // Same wedge from the other direction: a driven-only spec IS its driver, so
    // a declined one leaves nothing running to report.
    if (!this.driver && drivenOnly(spec)) {
      child?.kill("SIGTERM");
      this.noteExit(spec.id, { code: null, reason: "error" });
      throw new LaunchError(400, `${spec.label} could not start its loop`);
    }
    return started;
  }

  /**
   * One headless run of an automation prompt, resolved when the CLI exits.
   *
   * Everything except the prompt, the allowlist and the output capture is the
   * chat path: same binary resolution, same MCP config, same widened PATH,
   * same isolated workdir and per-CLI prepare step.
   *
   * Refuses at capacity rather than queueing internally. The scheduler owns
   * the queue and its FIFO order, and a launcher that blocked here would hold a
   * run row open while it waited.
   *
   * A live chat agent is not a reason to refuse. The two have separate slots.
   */
  async runOnce(opts: OneShotOptions): Promise<OneShotResult> {
    this.assertClosed();
    if (this.runCapacity() === 0) {
      const held = this.oneShots.size + this.starting.size;
      throw new LaunchError(
        409,
        `already running ${held} automation ${held === 1 ? "run" : "runs"}`,
      );
    }
    // The id names a directory. Every caller passes a UUID from the run row,
    // and this keeps it that way rather than trusting them: the same rule the
    // registry enforces for agent ids, applied to the one other string that
    // reaches the filesystem from outside this file.
    if (!/^[A-Za-z0-9_-]+$/.test(opts.runId)) {
      throw new LaunchError(400, "invalid run id");
    }
    if (this.oneShots.has(opts.runId) || this.starting.has(opts.runId)) {
      throw new LaunchError(409, `run ${opts.runId} is already in progress`);
    }
    // Held from here until the child is registered below, because validating a
    // model can suspend. The scheduler has already claimed the run row by now,
    // so a slot lost inside that window is not a wait, it is a lost fire.
    this.starting.add(opts.runId);
    // Minted before anything can spawn and revoked in finish(), which every
    // ending of this run goes through.
    const { ctx, grant } = this.launchCtx("run", `run:${opts.runId}`);
    let child: ChildProcess;
    let render: RenderRunLine | undefined;
    let workDir: string;
    /** This run's way out, when it is confined. Closed by finish(). */
    let egress: EgressProxy | null = null;
    /** What that way out allows, kept for the note the run log opens with. */
    let egressAllow: string[] = [];
    /**
     * Which CLI carried this run, and on which model. Reported on the result
     * and written to the run row, so history can say what actually ran rather
     * than what the automation asked for on the day it was saved.
     */
    let ranAgentId = "";
    let ranNote = "";
    try {
      const { spec, bin } = this.resolveRunSpec(opts.agentId);
      const model = opts.model ?? undefined;
      ranAgentId = spec.id;
      ranNote = `[boxaide] agent: ${spec.label} (${spec.id}), model: ${model ?? "default"}`;
      if (model !== undefined) {
        // The model id becomes an argv element, so it must be one the CLI
        // itself named, the same rule `start` applies to a chat launch.
        const offered = await this.modelsFor(spec, bin);
        if (!offered.some((m) => m.id === model)) {
          throw new LaunchError(400, `${spec.label} does not offer that model`);
        }
      }
      // That listing is the only suspension point before the spawn, and a
      // close() landing inside it would otherwise be followed by a run
      // starting anyway. Same re-check start() makes for the same reason.
      this.assertClosed();

      // Safely warm/verify token before starting confinement. If unauthenticated,
      // fail fast without launching the confined child or waiting for a timeout.
      if (spec.warmAuth) {
        const warmed = await spec.warmAuth(
          ctx,
          bin,
          this.childEnvFor(spec, this.listWorkDir(spec), ctx),
        );
        if (!warmed.ok) {
          this.starting.delete(opts.runId);
          grant?.revoke();
          const authNote = warmed.authRequired
            ? `[boxaide] auth-required: ${spec.label} needs sign-in. Use Sign in below or run \`${spec.bin}\` in Terminal, then run this automation again.`
            : `[boxaide] blocked: ${warmed.reason}. Try this automation again.`;
          logError("agent.launcher", "run readiness failed", {
            agent: spec.id,
            runId: opts.runId,
            reason: warmed.reason,
          });
          return {
            status: "error",
            exitCode: 1,
            log: `${ranNote}\n${authNote}\n`,
            agentId: spec.id,
          };
        }
      }
      this.assertClosed();

      render = spec.renderRunLine;
      workDir = this.prepareWorkDir(spec, ctx, runWorkDir(ctx, opts.runId));
      // Workspace memory rides between the preamble and the task: the
      // preamble states the boundaries, the notes give the background, and
      // the task stays last. A run gets neither the ask-first offer (nobody
      // is here to consent to a skim) nor the update duty (its directory is
      // not the workdir the notes live in), so an install without notes adds
      // nothing at all.
      const memory = runMemoryBlock(ctx.dataDir);
      const prompt = memory
        ? `${AUTOMATION_RUN_PREAMBLE}\n\n${memory}\n\n${opts.prompt}`
        : `${AUTOMATION_RUN_PREAMBLE}\n\n${opts.prompt}`;

      // A scheduled run is the case this matters most for: nobody is watching
      // it, and the mail it reads was written by strangers. So it is the one
      // launch that also loses the network: everything but loopback is denied
      // and its way out is the allowlisting proxy below (src/agent/egress.ts).
      // An unconfined install keeps what it had. With no sandbox there is
      // nothing holding the run to the proxy, and a boundary that can be
      // stepped around should not be claimed.
      const access = resolveAccess(this.ctx.access ?? "workspace").access;
      const confined = access !== "full" && !egressDisabled(this.env);
      if (confined) {
        egressAllow = allowedHostsFor(spec.id, this.env);
        egress = new EgressProxy(egressAllow);
        await egress.start();
      }
      const command = this.confine(
        spec,
        bin,
        workDir,
        access,
        confined ? "loopback" : "open",
        "run",
      );
      child = spawn(command.bin, [...command.prefix, ...spec.runArgs!(ctx, prompt, workDir, model)], {
        cwd: workDir,
        env: {
          ...this.childEnvFor(spec, workDir, ctx),
          ...(egress ? egressEnv(egress.url()) : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // No child, so nothing else will ever release this reservation, nor the
      // credential it was about to use, or the door the proxy is holding open.
      this.starting.delete(opts.runId);
      grant?.revoke();
      egress?.stop();
      throw err;
    }

    let log = "";
    const capture = (chunk: string) => {
      log = (log + chunk).slice(-ONESHOT_LOG_LIMIT);
    };
    /** A whole line of Boxaide's own, on its own row whatever came before. */
    const note = (line: string) => {
      capture(`${log && !log.endsWith("\n") ? "\n" : ""}${line}\n`);
    };
    // The boundary says so before the CLI speaks, so a run broken by it is
    // one line from its reason even when the CLI never reached the proxy.
    // First line of the log, before the CLI speaks: a run read weeks later
    // must say which agent produced it without anyone guessing.
    note(ranNote);
    if (egress) note(egressActiveNote(egressAllow));

    // Which status a kill produces. A deadline or a manual kill is 'killed';
    // the watchdog is 'error', because a run that never spoke did not start.
    let forced: "killed" | "error" | null = null;

    // Fast-fail if interactive OAuth is prompted during a headless run.
    // Do not capture raw OAuth URLs or codes into the log.
    let authRequired = false;
    const checkAuthPrompt = (chunk: string): boolean => {
      if (ranAgentId === "antigravity" && isAgyAuthPrompt(chunk)) {
        if (forced === null) {
          authRequired = true;
          note(
            "[boxaide] auth-required: Antigravity needs sign-in. Use Sign in below or run `agy` in Terminal, then run this automation again.",
          );
          forced = "error";
          child.kill("SIGKILL");
        }
        return true;
      }
      return false;
    };

    // A spec that asks its CLI for an event stream must render it: the raw
    // NDJSON is unreadable, and the run log's only audience is a person. The
    // splitter is kept so finish() can flush a killed run's partial last line.
    const split = render
      ? lineSplitter((line) => {
          const rendered = render(line);
          if (rendered !== null) capture(`${rendered}\n`);
        })
      : null;

    // First-output watchdog, armed only for a spec that narrates itself. See
    // ONESHOT_FIRST_OUTPUT_TIMEOUT_MS: a non-streaming CLI is silent by design,
    // so the same timer would kill a healthy grok run.
    const startWindow = opts.firstOutputTimeoutMs ?? ONESHOT_FIRST_OUTPUT_TIMEOUT_MS;
    let waiting: ReturnType<typeof setTimeout> | null = null;
    if (render) {
      waiting = setTimeout(() => {
        note(oneShotSilentNote(startWindow));
        forced = "error";
        child.kill("SIGKILL");
      }, startWindow);
      waiting.unref?.();
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (checkAuthPrompt(chunk)) return;
      // stdout only. stderr carries startup noise from things that are not the
      // session. A CLI's update check can feed a timer the agent never did.
      // First chunk is enough: mid-tool silence is healthy, so do not re-arm.
      if (waiting) {
        clearTimeout(waiting);
        waiting = null;
      }
      if (split) split(chunk);
      else capture(chunk);
    });
    // stderr stays raw whatever the spec does: a crash writes plain text here.
    child.stderr?.on("data", (chunk: string) => {
      if (checkAuthPrompt(chunk)) return;
      capture(chunk);
    });

    const timer = setTimeout(() => {
      note(oneShotDeadlineNote(opts.timeoutMs ?? ONESHOT_TIMEOUT_MS));
      forced = "killed";
      // SIGKILL, not SIGTERM: the deadline has already passed, and a CLI that
      // ignores a polite signal would hold the single run slot indefinitely.
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? ONESHOT_TIMEOUT_MS);
    timer.unref?.();
    // Registered only now, with its kill: everything above can still throw, and
    // an entry left in the map would consume a slot forever. The reservation
    // holds the slot until this line, so it is never briefly free.
    this.oneShots.set(opts.runId, {
      child,
      kill: () => {
        // Already being killed, by the deadline, the watchdog, or an earlier
        // call. Saying so twice would write the note into the log twice, and
        // the first reason is the true one.
        if (forced !== null) return;
        note(ONESHOT_KILLED_NOTE);
        forced = "killed";
        child.kill("SIGKILL");
      },
    });
    // The child holds the slot on its own now.
    this.starting.delete(opts.runId);

    const runStartedAt = Date.now();
    logInfo("agent.launcher", "run start", {
      agent: ranAgentId,
      runId: opts.runId,
      pid: child.pid ?? null,
      confined: egress !== null,
    });

    return await new Promise<OneShotResult>((resolve) => {
      let done = false;
      let grace: ReturnType<typeof setTimeout> | null = null;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (waiting) clearTimeout(waiting);
        if (grace) clearTimeout(grace);
        // A killed child's last line has no newline on it. It is still the
        // best evidence of what the run was doing when it died.
        split?.flush();
        // Before anything that can throw: this run's credential must not
        // outlive it, and a SIGKILLed child may still be draining pipes. The
        // proxy goes with it, and what it turned away goes in the log. A run
        // that failed because its CLI needed a host nobody listed must say so,
        // or the boundary is indistinguishable from a broken install.
        grant?.revoke();
        const refused = egress?.refusals() ?? [];
        const refusedTotal = egress?.refusedTotal() ?? 0;
        egress?.stop();
        if (refused.length > 0) note(egressRefusedNote(refused, refusedTotal));
        if (authRequired) {
          // The OAuth URL and paste-back prompt are CLI output. Keep none of
          // it, including a URL split across stream chunks; only our safe,
          // actionable conclusion survives in the encrypted run log.
          log = `${ranNote}\n[boxaide] auth-required: Antigravity needs sign-in. Use Sign in below or run \`agy\` in Terminal, then run this automation again.\n`;
        }
        // The slot is freed before the directory is removed: a failure to clean
        // up disk must not cost this launcher a run slot for the rest of the
        // process's life.
        this.oneShots.delete(opts.runId);
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // Left for the sweep at the next start.
        }
        const status = forced ?? (code === 0 ? "ok" : "error");
        // The run log itself goes to the automation row, which is a database a
        // failed install may not have. This line is the copy that survives on
        // disk, and it carries no run output: identifiers, a code, a duration.
        (status === "ok" ? logInfo : logError)("agent.launcher", "run exit", {
          agent: ranAgentId,
          runId: opts.runId,
          code,
          status,
          refused: refused.length > 0 ? refused.join(",") : null,
          upMs: Date.now() - runStartedAt,
        });
        resolve({
          status,
          exitCode: code,
          log,
          agentId: ranAgentId,
        });
      };
      child.on("error", (err) => {
        // Spawn failures (ENOENT, EACCES) never reach "close" with a code.
        capture(`\n${err.message}`);
        finish(null);
      });
      // "close" is the normal finish: it waits for stdout/stderr to drain, and
      // the log is the whole point of capturing.
      child.on("close", (code) => finish(code));
      // But "close" waits for every holder of those pipes, and a detached
      // grandchild can hold one open long after the agent is gone, and that is
      // what reported a 15-minute timeout as a 17-minute run. Past the grace
      // the process is dead and its duration is the honest answer.
      child.on("exit", (code) => {
        // A spawn failure finishes on "error" and still fires "exit"; without
        // this the grace timer is scheduled against an already-settled run.
        if (done) return;
        grace = setTimeout(
          () => finish(code),
          opts.closeGraceMs ?? ONESHOT_CLOSE_GRACE_MS,
        );
        grace.unref?.();
      });
    });
  }

  /**
   * Kills one in-flight automation run, or every one when given no id. No-op
   * when there is nothing to kill.
   *
   * The no-argument form is what shutdown wants: each run then finishes as
   * 'killed' with a log, instead of leaving a row that says 'running' until
   * some later process sweeps it.
   */
  killRun(runId?: string): void {
    if (runId !== undefined) {
      this.oneShots.get(runId)?.kill();
      return;
    }
    // Copied first: each kill deletes its own entry from the map on exit.
    for (const entry of [...this.oneShots.values()]) entry.kill();
  }

  /**
   * Ends the turn `seq` belongs to on the running agent, and leaves it up.
   *
   * The launched agent only. A message being answered by an agent that
   * connected over MCP is not this process's to kill. There is no child here
   * to signal, and false is what tells the route to say so.
   */
  interrupt(seq: number): boolean {
    return this.driver?.interrupt?.(seq) ?? false;
  }

  /** Idempotent: stopping with nothing running is a no-op. */
  stop(): void {
    this.stopRequested = true;
    // The child is captured before the driver is stopped, for the same reason
    // close() clears its state first: a driver may report the end of its loop
    // from inside its own stop(), which reaches noteExit and nulls `this.child`,
    // and a long-lived child read after that line would never be signalled.
    const child = this.child;
    // The loop first, and for a driven-only agent it is the only thing to stop:
    // its driver kills the turn in flight and ends the loop, which is the exit.
    // For a server-backed one it also keeps the driver from starting a turn
    // against a server that is being killed a line later.
    this.driver?.stop();
    child?.kill("SIGTERM");
    // State clears in the exit handler, so status() keeps saying "running"
    // only while the agent actually exists.
  }

  close(): void {
    this.closed = true;
    const had = this.running !== null;
    this.stopRequested = true;
    // State cleared before the driver is stopped, for the same reason noteExit
    // does it in that order: a driver may report the end of its loop from inside
    // its own stop(), and that lands in noteDriverStop.
    this.running = null;
    const driver = this.driver;
    this.driver = null;
    const child = this.child;
    this.child = null;
    // The loop next: it parks on the channel, and a wait left open would hold
    // the process past shutdown.
    driver?.stop();
    child?.kill("SIGTERM");
    this.chatGrant?.revoke();
    this.chatGrant = null;
    this.killRun();
    if (had) this.ctx.onRunningChange?.(null);
  }

  /**
   * An empty, dedicated working directory: no repository context, no
   * CLAUDE.md, nothing for the agent to read into the session by accident.
   * OpenCode is also passed this path as --dir; spawn cwd is not enough.
   *
   * The chat agent uses the shared one. Each automation run passes its own,
   * because runs overlap and an agent writes files where it stands.
   */
  private prepareWorkDir(
    spec: AgentSpec,
    ctx: LaunchContext,
    dir?: string,
  ): string {
    const workDir = dir ?? agentWorkDir(ctx.dataDir);
    mkdirSync(workDir, { recursive: true });
    // `ctx`, not `this.ctx`: prepare writes the credential into the CLI's
    // config file, and the credential is this launch's scoped token.
    spec.prepare?.(ctx, workDir, this.env);
    return workDir;
  }

  /**
   * The workdir a listing is described against, prepared so the config files
   * its env points at exist. A failure here is not fatal to a listing: the CLI
   * is asked anyway, against the bare path.
   *
   * Its own directory per agent, never the shared chat workdir. A listing
   * prepares with no credential (see `listCtx`), and the chat agent's config
   * files live in that shared directory: preparing there would overwrite a
   * running launch's MCP config with an empty bearer. That write used to be
   * harmless because it wrote the same master token a launch did; since the
   * credential is per-launch it is not.
   */
  private listWorkDir(spec: AgentSpec): string {
    const dir = join(agentRoot(this.ctx.dataDir), "model-list", spec.id);
    try {
      return this.prepareWorkDir(spec, this.listCtx(), dir);
    } catch {
      return dir;
    }
  }

  /**
   * The context a model listing is described against.
   *
   * Deliberately credential-free. Listing runs the CLI's own `models` command,
   * which never opens an MCP connection. But preparing the workdir writes a
   * config file, and that file outlives the listing. Writing a usable
   * credential there would leave one on disk that no launch owns and no exit
   * revokes. An empty string is inert: a stray connection with it is refused.
   */
  private listCtx(): LaunchContext {
    return { ...this.ctx, bearerToken: "" };
  }

  /**
   * The context one launch runs under: everything the launcher was built with,
   * except the credential, which is minted here and bound to `profile`.
   *
   * The grant comes back with it so the caller can revoke it when that launch
   * ends. A launcher with no minter falls back to the master bearer and no
   * grant, which is the pre-scope behaviour.
   */
  private launchCtx(
    profile: ScopeProfile,
    label: string,
  ): { ctx: LaunchContext; grant: ScopedGrant | null } {
    const grant = this.ctx.mintToken?.(profile, label) ?? null;
    if (!grant) return { ctx: this.ctx, grant: null };
    return { ctx: { ...this.ctx, bearerToken: grant.token }, grant };
  }

  /**
   * The command this launch actually spawns.
   *
   * Every spawn goes through here: the chat child, each run's child, and (via
   * `DriveOptions.command`) every turn a driver starts. That is the same shape
   * as the tool scope: one place decides, and a spec cannot opt out of it.
   *
   * Writable: the launch's own directory, plus the shared CLI config homes.
   * Denied last: the data directory, whatever else named it.
   *
   * A chat launch additionally owns the whole agent root, because the notes in
   * `workdir/memory/` are its to write and a person is reading what it says
   * about them. A scheduled run is the opposite case on both counts, so it
   * gets `kind: "run"`: the allow-back narrows to `agent-homes`, and the
   * memory directory is named in the deny list outright.
   *
   * That deny is the difference between a claim and a boundary. The review
   * gate (src/memory/reviews.ts) filters what `runMemoryBlock` puts in the
   * PROMPT; it says nothing about a CLI that runs shell commands and can walk
   * `../../memory/` from its own run directory. Without this, an unreviewed
   * note was one `cat` away from the run it was written to be kept from, and
   * a run could plant one for the next chat session to read.
   */
  private confine(
    spec: AgentSpec,
    bin: string,
    workDir: string,
    access: AgentAccess,
    network: NetworkAccess = "open",
    kind: "chat" | "run" = "chat",
  ): LaunchCommand {
    if (access === "full") return plainCommand(bin);
    const extra = spec.sandbox?.(this.ctx, workDir, this.env, kind) ?? {};
    const root = agentRoot(this.ctx.dataDir);
    const shared = kind === "run" ? join(root, "agent-homes") : root;
    return confineCommand({
      bin,
      access,
      network,
      write: [workDir, shared, ...(extra.write ?? [])],
      // The credential and the mail store. `:memory:` names no directory, so
      // there is nothing on disk to keep the agent out of. A run adds the
      // notes: an agent-root deny would take its own config homes with it, so
      // the one directory is named instead. Last comes whatever the spec
      // itself has to be kept out of, which for a run is the user's own agy
      // MCP config.
      deny: [
        ...(this.ctx.dataDir === ":memory:" ? [] : [this.ctx.dataDir]),
        ...(kind === "run" ? [memoryDir(this.ctx.dataDir)] : []),
        ...(extra.deny ?? []),
      ],
      home: this.env.HOME || undefined,
    });
  }

  private childEnvFor(
    spec: AgentSpec,
    workDir: string,
    ctx: LaunchContext = this.listCtx(),
  ): NodeJS.ProcessEnv {
    return this.baseEnvWith(spec.childEnv?.(ctx, workDir) ?? {});
  }

  private baseEnvWith(extras: Record<string, string>): NodeJS.ProcessEnv {
    return {
      ...this.env,
      // The widened PATH travels with the agent: launched from the Finder app
      // the inherited PATH lacks even the directory its own binary sits in.
      PATH: this.searchDirs().join(delimiter),
      ...extras,
    };
  }

  /**
   * Which CLI carries a run.
   *
   * A named agent is the one that runs, or the run fails with the reason. It
   * is never swapped for another: a schedule the user pointed at one CLI that
   * quietly ran on a different one, with different tools and a different
   * account, was a worse answer than a failed run with a sentence saying why.
   *
   * A null agentId means "first available", resolved in registry order
   * against what is installed and run capable, so an automation saved on a
   * machine that later loses that CLI still runs. Registry order is fixed, so
   * that choice is the same on every run, and the id that ran is written to
   * the run row.
   */
  private resolveRunSpec(agentId?: string | null): { spec: AgentSpec; bin: string } {
    if (agentId) {
      const spec = this.registry.find((s) => s.id === agentId);
      if (!spec) throw new LaunchError(404, `unknown agent: ${agentId}`);
      const bin = this.resolveBin(spec.bin);
      const runs = capabilityOf(spec, bin, this.ctx, this.env).runs;
      if (!runs.ok) throw new LaunchError(400, runs.reason!);
      // A missing binary is one of the reasons `runs` carries, so runs.ok
      // implies capabilityOf found one.
      return { spec, bin: bin! };
    }
    const found = this.registry
      .map((spec) => ({ spec, bin: this.resolveBin(spec.bin) }))
      .find(
        ({ spec, bin }) =>
          bin !== null && capabilityOf(spec, bin, this.ctx, this.env).runs.ok,
      );
    if (!found) {
      throw new LaunchError(400, "no agent CLI is installed to run automations");
    }
    return found as { spec: AgentSpec; bin: string };
  }

  /**
   * A driver's loop has ended.
   *
   * For a driven-only agent this is its exit: nothing else the launcher owns can
   * close, so without this `status().running` would stay true forever after a
   * driver gave up. A give-up carries its reason into `lastExit.stderrTail`,
   * which is what the pane reads to explain why the agent stopped answering.
   */
  private noteDriverStop(id: string, error: string | null, cause?: StopCause): void {
    if (this.running?.id !== id) return;
    if (error) this.stderrTail = `${this.stderrTail}\n${error}`.trim();
    // No code: a loop is not a process, and inventing 0 or 1 for it is what made
    // a stopped driven agent read as clean and a stopped child-backed one read
    // as a crash. The reason is the fact; the code stays absent because there
    // was none.
    this.noteExit(id, {
      code: null,
      reason: error ? "error" : "stopped",
      // Only a give-up can be a sign-out. A driver that reports one on a clean
      // stop is reporting the run before it, and the pane would offer a sign-in
      // for an agent the user simply switched off.
      authRequired: error !== null && cause?.authRequired === true,
    });
  }

  private noteExit(
    id: string,
    exit: { code: number | null; reason: ExitReason; authRequired?: boolean },
  ): void {
    if (this.running?.id !== id) return;
    // Written before the state is torn down, and written for every exit rather
    // than only the bad ones: `lastExit` below is in memory, so without this
    // line a restart is all it takes for the record of why an agent died to be
    // gone. The stderr tail is redacted and capped by src/log.ts.
    const startedAt = Date.parse(this.running.startedAt);
    // A clean finish and a Stop the user pressed are both ordinary. Only a
    // launch that ended some other way is worth a reader's attention.
    const clean = exit.reason === "stopped" || (exit.reason === "exited" && exit.code === 0);
    const level = clean ? logInfo : logError;
    level("agent.launcher", "chat exit", {
      agent: id,
      pid: this.running.pid,
      code: exit.code,
      reason: exit.reason,
      authRequired: exit.authRequired === true,
      upMs: Number.isFinite(startedAt) ? Date.now() - startedAt : null,
      stderrTail: this.stderrTail || null,
    });
    // Everything that can call back into this method is cleared FIRST. A driver
    // is free to report the end of its loop from inside its own stop(), and that
    // arrives here as another exit for the same agent, which would recurse
    // until the stack ran out if `running` and `driver` still pointed at the
    // launch being torn down.
    this.running = null;
    this.child = null;
    // The credential dies with the launch. A child that ignored SIGTERM and is
    // still alive on the next tick now holds a token the server refuses, which
    // is the point: revocation must not wait for the process to actually go.
    this.chatGrant?.revoke();
    this.chatGrant = null;
    const driver = this.driver;
    this.driver = null;
    // Whatever the loop was prompting is gone.
    driver?.stop();
    this.lastExit = {
      id,
      code: exit.code,
      reason: exit.reason,
      at: new Date().toISOString(),
      stderrTail: this.stderrTail,
      authRequired: exit.authRequired === true,
    };
    this.ctx.onRunningChange?.(null);
  }

  /** PATH first (a terminal run wins), then the well-known directories. */
  private searchDirs(): string[] {
    const fromPath = (this.env.PATH ?? "").split(delimiter).filter(Boolean);
    return [...new Set([...fromPath, ...this.extraBinDirs])];
  }

  private resolveBin(bin: string): string | null {
    const rawNames = bin === "agy" ? ["agy", "antigravity"] : [bin];
    const names =
      process.platform === "win32"
        ? rawNames.flatMap((n) => [`${n}.exe`, `${n}.cmd`, n])
        : rawNames;
    for (const dir of this.searchDirs()) {
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
}

export class LaunchError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

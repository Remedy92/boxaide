/**
 * The contract every agent CLI module implements, and the pieces more than one
 * of them needs.
 *
 * Split out of launcher.ts so a per-CLI module can be read on its own. This
 * file imports nothing from the launcher, which is what keeps the five CLI
 * modules, the registry and the launcher core free of a cycle.
 */
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { ReadEvent, RenderRunLine } from "./agent-stream.js";
import type { AgentDriver, DriverChannel, StopCause } from "./driver.js";
import { OUTREACH_CHAIN, OUTREACH_CHAIN_ONE_LINE } from "./guidance.js";
import { chatMemoryBlock } from "./memory-context.js";
import type { ModelLister, ModelOption } from "./model-list.js";
import type { AgentAccess, LaunchCommand } from "./sandbox.js";
import { scopeToolNames, type ScopeProfile } from "../mcp/scope.js";
import type { ScopedGrant } from "../mcp/scoped-tokens.js";

/**
 * Same loop the Connect-your-agent dialog tells the user to paste. This is
 * the automated version of that manual step. Mirrors
 * apps/web/src/components/dialogs/agent-connect-dialog.tsx (KICKOFF).
 */
export const KICKOFF = `You are my Boxaide inbox agent. Use the Boxaide MCP tools.

Loop: call chat_await_message, do the work, post the answer with chat_say, then
call chat_await_message again. Keep going until I tell you to stop.

Everything I read appears in the Boxaide window, so every answer must go through
chat_say. Do not answer here. A chat_await_message that returns no message is
normal; call it again. Use chat_activity for anything slow. Draft rather than
send unless I ask you to send.

${OUTREACH_CHAIN}`;

/**
 * Prepended verbatim to every automation prompt (spec: Scheduler / Run
 * preamble). It states the two boundaries the server also enforces, no chat
 * and no sending, because a model that understands why it is being refused writes
 * a draft instead of retrying the wall.
 */
export const AUTOMATION_RUN_PREAMBLE =
  "You are a scheduled Boxaide automation. Do the task below using the Boxaide MCP tools, then exit. You cannot talk to the user: do not call chat tools; write nothing to the user. Never send email; the chain below says where outreach goes. " +
  OUTREACH_CHAIN_ONE_LINE;

/**
 * KICKOFF plus whatever this install's workspace memory adds to it.
 *
 * Every chat launch (Grok, Antigravity, Codex) gets the same prompt, so the
 * block is appended here once rather than at each spec's args builder.
 * Appended rather than folded into the const: KICKOFF is exported and mirrored
 * in the connect dialog, and neither copy should change shape because one
 * install has notes and another does not.
 */
export function kickoffPrompt(ctx: LaunchContext): string {
  const memory = chatMemoryBlock(ctx.dataDir);
  return memory ? `${KICKOFF}\n\n${memory}` : KICKOFF;
}

/**
 * The allowlists a CLI is given on its command line.
 *
 * These are no longer the boundary. src/mcp/scope.ts is: the token each launch
 * carries is bound to a scope, and the server refuses anything outside it
 * whatever the CLI was told. These flags stay because a refusal the CLI makes
 * itself is cheaper and clearer than one that comes back as a tool error, and
 * because a CLI that offers them should be held to them.
 *
 * They are derived from the scope rather than written twice. The two lists
 * drifting apart is what made a launched agent's real permissions a question
 * nobody could answer from one file.
 */
export function chatPreapprovedToolNames(): string[] {
  return scopeToolNames("chat");
}

/**
 * A driven session gets everything the chat agent gets except the loop's own
 * three: the driver already holds the lease, and a model that could also call
 * chat_await_message would answer the same message twice.
 */
export function drivenPreapprovedToolNames(): string[] {
  return scopeToolNames("driven");
}

/** A headless automation run: no chat at all, and the schedule is read-only. */
export function runPreapprovedToolNames(): string[] {
  return scopeToolNames("run");
}

export type LaunchContext = {
  mcpUrl: string;
  /**
   * The credential this launch writes into its CLI's config.
   *
   * On the context the launcher is constructed with this is the master bearer,
   * and it is never what a spawned agent gets: every launch replaces it with a
   * scoped token from `mintToken` before a spec sees the context. It stays on
   * the type because the specs read it by that name, and because a launcher
   * built without a minter (tests, the CLI) still has to hand its CLI
   * something that works.
   */
  bearerToken: string;
  /**
   * Mints the credential for one launch, bound to a scope the MCP server
   * enforces. Absent means no scoping is available in this process, and the
   * launch falls back to `bearerToken`, the pre-scope behaviour, kept so a
   * launcher can still be constructed standalone.
   */
  mintToken?: (profile: ScopeProfile, label: string) => ScopedGrant;
  /**
   * How much of the machine a launch may reach when the caller does not say.
   * `workspace` unless this process was configured otherwise. See sandbox.ts.
   */
  access?: AgentAccess;
  /** Where the agent's empty working directory is created. */
  dataDir: string;
  /**
   * Fired when the child starts and when it exits. The conversation channel
   * uses this so the Agent pane names the CLI the user pressed Start on,
   * not whichever leftover MCP client last called initialize.
   */
  onRunningChange?: (id: string | null) => void;
  /**
   * Fired for every line the chat agent writes to stdout: proof the process is
   * alive, plus the tool it just started when the line names one.
   *
   * This is the whole point of reading the stream. An agent doing its own work,
   * reading files, running commands or thinking, calls no Boxaide tool for
   * minutes at a time, and without this the pane can only report silence.
   */
  onActivity?: (tool: string | null) => void;
  /**
   * The conversation channel, for specs that drive their CLI in process
   * (`AgentSpec.drive`) instead of leaving the loop to a kickoff prompt.
   * Absent in a process that has no channel to hand messages to; those specs
   * then launch exactly as before and the MCP tier carries the conversation.
   */
  channel?: DriverChannel;
  /**
   * Whether this server has a search connector configured.
   *
   * False means the CLI keeps its own web search and fetch: with no Boxaide
   * web_search there is nothing to prefer, and an agent that cannot look
   * anything up is worse than one using its vendor's index. True means Boxaide
   * owns search, so the CLI's native web tools stay off and the agent goes
   * through web_search and web_fetch.
   *
   * Called per launch, not read at construction, so a key saved in Settings
   * changes the next agent without a restart. Absent means the same as true:
   * a launcher built standalone (tests, the CLI) keeps today's stripping.
   */
  searchConfigured?: () => boolean;
};

/**
 * Whether this launch may use its CLI's own web tools. Absent thunk means no,
 * so the conservative behaviour is what a context without the field gets.
 */
export function nativeWebAllowed(ctx: LaunchContext): boolean {
  return ctx.searchConfigured?.() === false;
}


/** What a spec's `drive` is handed when the launcher starts it. */
export type DriveOptions = {
  /**
   * The long-lived child, when the spec has `args`. Null for a spec that has
   * none: its driver owns the child processes, and there is nothing else.
   */
  child: ChildProcess | null;
  /** The resolved binary, for a driver that spawns its own children. */
  bin: string;
  /**
   * The same binary, as the launcher actually spawns it: confined when this
   * launch is confined. A driver that builds its own argument list per turn
   * must spawn `command.bin` with `[...command.prefix, ...its own args]`, or
   * its children are the one part of the launch outside the sandbox.
   */
  command: LaunchCommand;
  workDir: string;
  model?: string;
  /** The full child environment, exactly as the launcher's own spawn built it. */
  env: NodeJS.ProcessEnv;
  /** The spec's own childEnv entries alone. Per-launch secrets ride here. */
  childEnv: Record<string, string>;
  /**
   * The launcher's own environment, before any spec overlay, the same thing
   * `prepare` is handed. A driver that has to repair what `prepare` copied
   * needs the home it was copied FROM, and `env` cannot answer that: the
   * spec's childEnv has already overwritten the variable naming it.
   */
  parentEnv: NodeJS.ProcessEnv;
  /**
   * Reports the loop's end. For a spec with no `args` this is the only exit
   * there is, because nothing else the launcher owns can close, so a driver that gave
   * up passes the reason and it becomes `lastExit`. Null means it was stopped.
   * The cause carries what the reason string cannot be parsed for.
   */
  onStop: (error: string | null, cause?: StopCause) => void;
};

export type AgentSpec = {
  id: string;
  label: string;
  /** Binary name looked up on PATH. */
  bin: string;
  /**
   * The CLI's own "list your models" command. When set, this is the source of
   * truth and `models` is never consulted; the launcher runs it, caches the
   * answer, and validates a picked id against it.
   */
  listModels?: ModelLister;
  /**
   * Models this CLI accepts, typed out here. Only for a CLI that has no
   * listing command at all, or as the fallback while `listModels` is failing.
   * Absent and with no lister means no picker.
   */
  models?: ModelOption[];
  /**
   * argv for one long-lived child: a KICKOFF session, or a server the spec's
   * driver prompts. Absent with a `drive` means the driver owns its own children
   * and the launcher spawns nothing; absent with neither means this CLI cannot
   * be launched, and it is listed only so the UI can say "found, not wired up
   * yet" instead of pretending it does not exist.
   */
  args?: (ctx: LaunchContext, model?: string) => string[];
  /**
   * Headless one-shot form used by automation runs: the same wiring as `args`
   * with the automation prompt and the run allowlist. Absent means this CLI
   * cannot carry a scheduled run, even when it can carry the chat loop.
   *
   * Takes `workDir` because runs may overlap and each gets its own: any path a
   * run's command line names must be that run's, not a directory a sibling run
   * is rewriting underneath it.
   */
  runArgs?: (
    ctx: LaunchContext,
    prompt: string,
    workDir: string,
    model?: string,
  ) => string[];
  /**
   * Extra child env, overlayed on the inherited env (and the widened PATH).
   * Grok has no --strict-mcp-config; GROK_HOME plus these flags keep the
   * process from picking up the user's other MCP servers.
   */
  childEnv?: (ctx: LaunchContext, workDir: string) => Record<string, string>;
  /**
   * Runs after the empty workdir exists and before spawn. Grok has no
   * --mcp-config flag; this writes the isolated config the process will read.
   */
  prepare?: (
    ctx: LaunchContext,
    workDir: string,
    parentEnv: NodeJS.ProcessEnv,
  ) => void;
  /**
   * Reads one stdout line of this CLI's event stream. Set only for specs whose
   * `args` ask for that stream; without it the chat agent's stdout is drained
   * and discarded, which is what every CLI did before. A driven spec with no
   * `args` passes its reader to its driver instead. There is no child here.
   */
  readEvent?: ReadEvent;
  /**
   * Turns one stdout line of a one-shot run into the text its log keeps. Set
   * only for specs whose `runArgs` ask for an event stream; without it the run
   * log is the raw bytes the CLI wrote, which is what every CLI did before.
   */
  renderRunLine?: RenderRunLine;
  /**
   * What this CLI needs from the user's home when a launch is confined.
   *
   * The sandbox allows the agent's own directories and the tree its binary is
   * installed in; everything else under the home is denied. A CLI that keeps
   * its credentials, its config or its cache somewhere else has to say so
   * here, or a confined launch starts and then cannot authenticate.
   *
   * Writable, all of it. Every CLI here keeps its sign-in by writing a token
   * down and rewriting it when it refreshes, and OpenCode creates four
   * directories before it will run at all. A denied write in either case is
   * fatal, and the first kind fails silently.
   *
   * `deny` is the other direction, and it is written after every allow, so it
   * beats them. One user is agy: a run is kept out of the user's own MCP
   * config file while `~/.gemini` around it stays writable. `kind` is what
   * lets a spec draw that line between a watched chat launch and an
   * unattended run.
   */
  sandbox?: (
    ctx: LaunchContext,
    workDir: string,
    parentEnv: NodeJS.ProcessEnv,
    kind: "chat" | "run",
  ) => { write?: string[]; deny?: string[] };
  /**
   * Whether Boxaide really keeps this CLI off the user's own configuration
   * during a run, and in one sentence how.
   *
   * A pure descriptor: it decides nothing and reports what the other hooks on
   * this spec already do. `confined` is false when the launch gets no sandbox
   * at all (no sandbox on this platform, or BOXAIDE_AGENT_ACCESS=full), which
   * a spec relying on sandbox rules rather than on a config home must answer
   * differently. Absent means Boxaide claims no isolation for this CLI.
   */
  isolation?: (
    env: NodeJS.ProcessEnv,
    confined: boolean,
  ) => { isolated: boolean; note: string };
  /**
   * A precondition this CLI cannot be launched without, checked before
   * anything is spawned. Returns the reason to refuse, or null to go ahead.
   *
   * The one case today is agy, whose MCP servers come from a file in the
   * user's home that Boxaide neither owns nor can override. Any CLI whose
   * configuration can be contradicted from outside Boxaide belongs here: the
   * launcher's promise is that a launched agent holds the credential Boxaide
   * minted for it, and a spec that cannot keep that promise must say so
   * instead of starting.
   */
  preflight?: (ctx: LaunchContext, env: NodeJS.ProcessEnv) => string | null;
  /**
   * Runs the chat loop in this process, for a CLI whose model must not be asked
   * to run it. Called once, straight after the launch; the launcher stops it
   * when the child exits or is stopped. Null means the driver declined (no
   * channel), which leaves a long-lived child running untouched.
   */
  drive?: (ctx: LaunchContext, opts: DriveOptions) => AgentDriver | null;
};

export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function refreshLink(from: string, to: string): void {
  // Built under a temporary name and renamed over the target, never unlinked in
  // place: rename is atomic, so a launch reading this path either sees the old
  // link or the new one. The unlink-then-symlink it replaced left a window with
  // no file at all, which a second launch starting in that window read as
  // "not authenticated".
  const temp = tempPathFor(to);
  try {
    symlinkSync(from, temp);
  } catch {
    try {
      copyFileSync(from, temp);
    } catch {
      // Nothing was staged, so there is nothing to rename and nothing to undo.
      // The existing target, if any, is left exactly as it was.
      return;
    }
  }
  try {
    renameSync(temp, to);
  } catch {
    // Leave the target alone rather than half-replaced, and do not strand the
    // staged file.
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Write a 0600 file so no reader ever sees it half-written.
 *
 * Every config this module writes is read by a CLI that may be starting right
 * now for a different run. writeFileSync truncates first, so a plain write has
 * a window where the file exists and is empty or partial. Rare, silent, and
 * exactly the kind of failure that only appears once runs can overlap.
 */
export function writeSecret(path: string, content: string): void {
  const temp = tempPathFor(path);
  writeFileSync(temp, content, { mode: 0o600 });
  // writeFile preserves an existing file's mode; force the invariant even if an
  // earlier build or local user created it more broadly.
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** The same staging, for a file whose content comes from another file. */
export function copySecret(from: string, to: string): void {
  const temp = tempPathFor(to);
  copyFileSync(from, temp);
  chmodSync(temp, 0o600);
  renameSync(temp, to);
}

/**
 * A staging path beside the target, in the same directory, so the rename stays on one
 * filesystem. The pid and counter keep two launches in one process, or two
 * processes over one data directory, off each other's staging file.
 */
let tempCounter = 0;
function tempPathFor(path: string): string {
  return `${path}.${process.pid}.${tempCounter++}.tmp`;
}

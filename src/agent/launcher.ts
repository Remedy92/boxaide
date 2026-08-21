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
 *  - A KICKOFF launch (Grok, Antigravity) is one long-lived child, and the loop
 *    exists because the prompt tells the model to keep calling
 *    chat_await_message. That loop is a suggestion, and it ends when the model
 *    decides it has finished.
 *  - A driven launch (Claude Code) hands the loop to a driver in this process —
 *    see driver.ts. `spec.drive` builds it. There is no long-lived child: the
 *    driver spawns one process per turn.
 *
 * Security posture, decided by the user and enforced here:
 *  - Only binaries from the fixed registry below are ever spawned, resolved
 *    from PATH, with argv built entirely in this file. No request input
 *    reaches a command line.
 *  - Every launch carries a scoped credential, not the master bearer, and the
 *    MCP server refuses anything outside that scope — see src/mcp/scope.ts.
 *    Sending mail and creating meetings are outside every agent scope. The
 *    per-tool flags below (Claude's --allowedTools, Grok's --allow) mirror the
 *    same scope onto the CLIs that offer them, so a refusal happens early
 *    where it can; the CLIs that offer no such flag are launchable anyway,
 *    because the wall no longer lives in the client.
 *  - One CHAT agent at a time. The channel hands each user message to exactly
 *    one waiter; a second launched chat agent would race it for every message.
 *    Automation runs are separate and may overlap — see `runOnce` and
 *    docs/specs/agent-platform.md invariant 4.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { agentRoot, agentWorkDir } from "./paths.js";
import {
  lineSplitter,
  readGrokEvent,
  readOpenCodeEvent,
  renderClaudeRunLine,
  type ReadEvent,
  type RenderRunLine,
} from "./agent-stream.js";
import { ClaudeDriver, type ClaudeTurnRequest } from "./claude-driver.js";
import type { AgentDriver, DriverChannel, StopCause } from "./driver.js";
import {
  OUTREACH_CHAIN,
  OUTREACH_CHAIN_ONE_LINE,
} from "./guidance.js";
import {
  allowedHostsFor,
  egressDisabled,
  EgressProxy,
  egressEnv,
} from "./egress.js";
import { chatMemoryBlock, runMemoryBlock } from "./memory-context.js";
import { OpenCodeDriver, serveBaseUrl } from "./opencode-driver.js";
import {
  fetchModels,
  parseBareModels,
  parseBulletModels,
  parseTabbedModels,
  type ModelLister,
  type ModelOption,
} from "./model-list.js";
import { scopeToolNames, type ScopeProfile } from "../mcp/scope.js";
import {
  confineCommand,
  type NetworkAccess,
  plainCommand,
  resolveAccess,
  type AgentAccess,
  type LaunchCommand,
} from "./sandbox.js";
import type { ScopedGrant } from "../mcp/scoped-tokens.js";

/**
 * Where agent CLIs actually live, beyond PATH.
 *
 * A macOS app launched from Finder inherits launchd's PATH —
 * /usr/bin:/bin:/usr/sbin:/sbin — not the login shell's. Every agent CLI on a
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
 * Same loop the Connect-your-agent dialog tells the user to paste — this is
 * the automated version of that manual step. Mirrors
 * apps/web/src/components/dialogs/agent-connect-dialog.tsx (KICKOFF).
 */
export const KICKOFF = `You are my Boxaide inbox agent. Use the Boxaide MCP tools.

Loop: call chat_await_message, do the work, post the answer with chat_say, then
call chat_await_message again. Keep going until I tell you to stop.

Everything I read appears in the Boxaide window, so every answer must go through
chat_say — do not answer here. A chat_await_message that returns no message is
normal; call it again. Use chat_activity for anything slow. Draft rather than
send unless I ask you to send.

${OUTREACH_CHAIN}`;

/**
 * Prepended verbatim to every automation prompt (spec: Scheduler / Run
 * preamble). It states the two boundaries the server also enforces — no chat,
 * no sending — because a model that understands why it is being refused writes
 * a draft instead of retrying the wall.
 */
export const AUTOMATION_RUN_PREAMBLE =
  "You are a scheduled Boxaide automation. Do the task below using the Boxaide MCP tools, then exit. You cannot talk to the user: do not call chat tools; write nothing to the user. Never send email; the chain below says where outreach goes. " +
  OUTREACH_CHAIN_ONE_LINE;

/**
 * KICKOFF plus whatever this install's workspace memory adds to it.
 *
 * Every chat launch — Grok, Antigravity, Codex — gets the same prompt, so the
 * block is appended here once rather than at each spec's args builder.
 * Appended rather than folded into the const: KICKOFF is exported and mirrored
 * in the connect dialog, and neither copy should change shape because one
 * install has notes and another does not.
 */
function kickoffPrompt(ctx: LaunchContext): string {
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
   * launch falls back to `bearerToken` — the pre-scope behaviour, kept so a
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
   * This is the whole point of reading the stream. An agent doing its own work
   * — reading files, running commands, thinking — calls no Boxaide tool for
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
function nativeWebAllowed(ctx: LaunchContext): boolean {
  return ctx.searchConfigured?.() === false;
}

/**
 * Claude Code's own web tools, by the names its `--allowedTools` expects.
 * Verified against claude 2.1.233. WebFetch is deliberately withheld: it is a
 * raw fetch with none of the address checks src/research/safe-url.ts applies
 * to boxaide's own web_fetch, so granting it would let a hostile URL in mail
 * reach loopback or link-local services. Search results alone are enough for
 * the unconfigured fallback.
 */
const CLAUDE_NATIVE_WEB_TOOLS = ["WebSearch"];

export type { ModelOption } from "./model-list.js";

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
   * The launcher's own environment, before any spec overlay — the same thing
   * `prepare` is handed. A driver that has to repair what `prepare` copied
   * needs the home it was copied FROM, and `env` cannot answer that: the
   * spec's childEnv has already overwritten the variable naming it.
   */
  parentEnv: NodeJS.ProcessEnv;
  /**
   * Reports the loop's end. For a spec with no `args` this is the only exit
   * there is — nothing else the launcher owns can close — so a driver that gave
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
   * `args` passes its reader to its driver instead — there is no child here.
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
   * directories before it will run at all — a denied write in either case is
   * fatal, and the first kind fails silently.
   */
  sandbox?: (
    ctx: LaunchContext,
    workDir: string,
    parentEnv: NodeJS.ProcessEnv,
  ) => { write?: string[] };
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

/**
 * One driven turn of Claude Code, as a command line.
 *
 * There is no server to prompt and no `claude` mode that stays up, so a turn is
 * a process: the user's message as the prompt, and `--resume` carrying the
 * session the last turn reported. Exported for the driver and for tests; the
 * launcher is the only place that decides what flags Boxaide passes to a CLI.
 *
 * --strict-mcp-config keeps the user's other MCP servers out of a process
 * Boxaide is responsible for; the allowlist is the read/draft boundary (send
 * stays un-approved, which headless mode denies) minus the chat tools, which
 * belong to the driver.
 */
export function claudeTurnArgs(
  ctx: LaunchContext,
  turn: ClaudeTurnRequest,
  model?: string,
): string[] {
  return [
    ...claudeFlagsFor(
      drivenPreapprovedToolNames().map((name) => `mcp__boxaide__${name}`),
      // The chat agent owns the shared workdir: it is the only launch that
      // uses it, and its session outlives any single turn.
      agentWorkDir(ctx.dataDir),
      { nativeWebTools: nativeWebAllowed(ctx), model },
    ),
    // What is left of KICKOFF once Boxaide runs the loop: the reply text is the
    // answer, and no loop tool is to be called. Appended rather than folded into
    // the prompt so it frames every turn, including one after a fresh session.
    "--append-system-prompt",
    turn.system,
    ...(turn.sessionId ? ["--resume", turn.sessionId] : []),
    ...claudePromptArgs(turn.prompt),
  ];
}

/**
 * The prompt, last and behind `--`.
 *
 * `-p` is a boolean flag and the prompt is a positional argument, so the user's
 * message is parsed as options unless option parsing is closed first: verified
 * against claude 2.1.233, `-p --version` prints the version and exits, and
 * `-p --help hi` fails with "unknown option". A chat message beginning with a
 * dash is ordinary text, so without this a turn would silently answer something
 * else or not run at all. Also verified there: with `--` the same text arrives
 * as the prompt, including alongside `--resume` and directly after the variadic
 * `--allowedTools`.
 */
function claudePromptArgs(prompt: string): string[] {
  return ["--", prompt];
}

function claudeDrive(
  ctx: LaunchContext,
  opts: DriveOptions,
): AgentDriver | null {
  // Without a channel there is nobody to drive for. `start` refuses this launch
  // before it gets here, since a Claude Code launch is nothing but its driver.
  if (!ctx.channel) return null;
  return new ClaudeDriver({
    channel: ctx.channel,
    agent: "claude-code",
    // Read per turn, not once here: the agent writes its notes during a
    // session, and a block frozen at launch would keep saying there are none.
    memorySystem: () => chatMemoryBlock(ctx.dataDir),
    // The launch's command, not the bare binary: Claude Code has no long-lived
    // child, so these per-turn spawns are the whole agent. Spawning `opts.bin`
    // here would leave every turn outside the sandbox the launch asked for.
    bin: opts.command.bin,
    cwd: opts.workDir,
    env: opts.env,
    argsFor: (turn) => [
      ...opts.command.prefix,
      ...claudeTurnArgs(ctx, turn, opts.model),
    ],
    // The driver decides when a sign-in failure is worth one repair; which
    // files that repair touches stays here, with everything else that knows
    // where a launch keeps its home.
    healAuth: () =>
      claudeHealCredentials(claudeParentHome(opts.parentEnv), claudeConfigHomeFor(ctx)),
    onStop: opts.onStop,
  }).start();
}

/**
 * One-shot form: same `-p` and event stream as a driven turn, different prompt
 * and allowlist, and no session to carry. A run answers once and exits.
 * `renderRunLine` turns the stream back into text a person reads — plain `-p`
 * printed nothing until the end, so a hung run wrote a zero-byte log.
 */
function claudeRunArgs(
  ctx: LaunchContext,
  prompt: string,
  workDir: string,
  model?: string,
): string[] {
  return [
    ...claudeFlagsFor(
      runPreapprovedToolNames().map((name) => `mcp__boxaide__${name}`),
      workDir,
      { nativeWebTools: nativeWebAllowed(ctx), model },
    ),
    // A run's prompt always opens with AUTOMATION_RUN_PREAMBLE, so it cannot
    // lead with a dash today. Behind `--` anyway: the day something is prepended
    // to it, that would be an automation that silently stopped running.
    ...claudePromptArgs(prompt),
  ];
}

/**
 * Everything on a `claude -p` command line except the prompt itself.
 *
 * `workDir` is the launch's own directory: `claudePrepare` writes that
 * launch's MCP config into it, and naming it here is what keeps two
 * overlapping runs off each other's config file.
 *
 * `--allowedTools` is an exhaustive allowlist, so Claude's own web tools are
 * excluded unless `nativeWebTools` adds WebSearch (and only WebSearch; see
 * CLAUDE_NATIVE_WEB_TOOLS). Never drop the flag to grant them: that would
 * un-gate Bash and the file tools with it.
 */
function claudeFlagsFor(
  allowedTools: string[],
  workDir: string,
  opts: { nativeWebTools: boolean; model?: string },
): string[] {
  const allowed = opts.nativeWebTools
    ? [...allowedTools, ...CLAUDE_NATIVE_WEB_TOOLS]
    : allowedTools;
  return [
    "-p",
    ...(opts.model ? ["--model", opts.model] : []),
    // NDJSON of the session's own events, which agent-stream.ts reads for
    // presence. --verbose is what makes -p emit the per-event lines rather
    // than only the final result; both flags were verified against the CLI.
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    join(workDir, "claude-mcp.json"),
    "--strict-mcp-config",
    "--allowedTools",
    allowed.join(","),
  ];
}

/**
 * Claude Code's own config home, isolated the way Grok's is.
 *
 * --strict-mcp-config only covers MCP servers. Everything else `claude` reads
 * out of ~/.claude — hooks, skills, output styles, subagents, settings — still
 * loads, and a scheduled run was observed picking up the user's personal set:
 * a run Boxaide is responsible for must not be reshaped by files the user
 * wrote for their own terminal. CLAUDE_CONFIG_DIR moves all of it to a
 * directory this launcher owns. Deliberately applied to the chat path too —
 * the isolation is about whose config runs, not which path.
 *
 * Shared across overlapping runs, unlike Grok's home, because this one
 * accumulates state the CLI itself owns — onboarding, project records, refreshed
 * credentials. Handing every run an empty home would make each one a first run.
 * `claude` already supports several sessions against one config directory; what
 * it cannot survive is a half-written file, so every write here is staged and
 * renamed (writeSecret / copySecret).
 */
function claudeConfigHomeFor(ctx: LaunchContext): string {
  return join(agentRoot(ctx.dataDir), "agent-homes", "claude");
}

function claudeChildEnv(
  ctx: LaunchContext,
  _workDir: string,
): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: claudeConfigHomeFor(ctx) };
}

function claudePrepare(
  ctx: LaunchContext,
  workDir: string,
  parentEnv: NodeJS.ProcessEnv,
): void {
  // Keep the primary bearer out of process listings and crash-report argv.
  writeSecret(
    join(workDir, "claude-mcp.json"),
    JSON.stringify({
      mcpServers: {
        boxaide: {
          type: "http",
          url: ctx.mcpUrl,
          headers: { Authorization: `Bearer ${ctx.bearerToken}` },
        },
      },
    }),
  );

  const home = claudeConfigHomeFor(ctx);
  mkdirSync(home, { recursive: true });
  const parentHome = claudeParentHome(parentEnv);
  claudeCopyCredentials(parentHome, home);
  claudeWriteAuthSettings(parentHome, home);
}

/** Where the user's own `claude` keeps its config, as that CLI resolves it. */
function claudeParentHome(parentEnv: NodeJS.ProcessEnv): string {
  return parentEnv.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * Auth is the one thing the isolated home must inherit.
 *
 * Copied per launch rather than symlinked: `claude` rewrites this file when it
 * refreshes a token, and through a symlink that write lands in the user's own
 * ~/.claude/.credentials.json — a process Boxaide is responsible for must not
 * edit the user's terminal auth. prepare runs before every spawn, so the copy
 * is at most one run stale. On macOS the credentials live in the keychain and
 * there is no file at all; then nothing is copied and the CLI finds its own —
 * keyed to the config directory, which is why a login made inside the isolated
 * home (the sign-in route's job) is the only one a launch can actually see.
 *
 * Never over a login the home owns. Once `claude /login` has run inside the
 * isolated home, that home's credential — keychain entry or file — is the real
 * one, and seeding a copy of the user's terminal file on top of it would
 * shadow a working login with a possibly-stale leftover: the exact failure
 * the heal below exists to undo.
 */
export function claudeCopyCredentials(parentHome: string, home: string): void {
  if (claudeHomeOwnsLogin(home)) return;
  try {
    copySecret(
      join(parentHome, ".credentials.json"),
      join(home, ".credentials.json"),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    // Unreadable credentials are not fatal: the CLI reports its own auth error,
    // and a prepare that throws would fail the launch instead.
  }
}

/**
 * Undoes a bad credential copy, mid-run, when the CLI says it is signed out.
 *
 * The copy above is the launch's weakest link. On macOS the real login normally
 * lives in the keychain and there is no file to copy — but if one was ever
 * written, by an older CLI or an expired session, it stays on disk, gets copied
 * into every launch, and SHADOWS the keychain login the CLI would otherwise
 * find. A perfectly signed-in machine then runs a signed-out agent, forever,
 * and the only symptom is "Not logged in" arriving as the answer to every
 * question.
 *
 * So: drop the copy, which restores whatever fallback the CLI has of its own,
 * and take a fresh one only if the user's file is genuinely newer than what was
 * copied — a login that landed after this launch started is the other way this
 * gets fixed, and it must not be overwritten by staleness in the other
 * direction. Nothing here touches the user's own file; the isolation the copy
 * exists for still holds.
 *
 * Returns whether anything moved, because the caller's decision is whether to
 * spend another turn: a repair that changed no bytes would be retried against
 * the identical credential.
 */
export function claudeHealCredentials(parentHome: string, home: string): boolean {
  // A home that signed in for itself has no copy to undo: its credential IS
  // the login, and a turn that still failed on it needs the user, not a byte
  // moved from the parent — which would shadow the home's own login with the
  // terminal leftover this repair exists to delete.
  if (claudeHomeOwnsLogin(home)) return false;
  const copied = join(home, ".credentials.json");
  const parent = join(parentHome, ".credentials.json");
  const copiedAt = mtimeOrNull(copied);
  let healed = false;
  if (copiedAt !== null) {
    try {
      unlinkSync(copied);
      healed = true;
    } catch {
      // Already gone, or not ours to remove. Either way the fresh copy below
      // is still worth attempting.
    }
  }
  const parentAt = mtimeOrNull(parent);
  if (parentAt !== null && (copiedAt === null || parentAt > copiedAt)) {
    try {
      copySecret(parent, copied);
      healed = true;
    } catch {
      // Unreadable or unwritable. The delete above already improved matters,
      // and a failed copy is not worth failing the turn over.
    }
  }
  return healed;
}

/**
 * Whether a `claude /login` has landed inside this home itself.
 *
 * The CLI records the signed-in account in its config directory's
 * `.claude.json` (`oauthAccount`), whether the token went to a file or to the
 * macOS keychain. That record is the only durable trace a keychain-backed
 * login leaves, so it is what decides "this home has its own auth" for the
 * copy and heal above. Exported for their tests.
 */
export function claudeHomeOwnsLogin(home: string): boolean {
  try {
    const record = JSON.parse(
      readFileSync(join(home, ".claude.json"), "utf8"),
    ) as Record<string, unknown>;
    return record.oauthAccount !== undefined && record.oauthAccount !== null;
  } catch {
    // No record, or one the CLI is mid-rewrite on. Not owning a login is the
    // safe reading: the copy stays possible and the heal stays available.
    return false;
  }
}

function mtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The only settings.json keys allowed across the isolation boundary.
 *
 * `env` carries ANTHROPIC_API_KEY, base URLs and the Bedrock/Vertex switches;
 * `apiKeyHelper` names a command that prints a key. Users who authenticate that
 * way have no credentials file, so isolation left their runs with no auth at
 * all. Everything else in that file — hooks, statusLine, outputStyle, model
 * overrides — is exactly what the isolated home exists to keep out.
 */
const CLAUDE_AUTH_SETTING_KEYS = ["env", "apiKeyHelper"] as const;

function claudeWriteAuthSettings(parentHome: string, home: string): void {
  try {
    const parsed = JSON.parse(
      readFileSync(join(parentHome, "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    const auth: Record<string, unknown> = {};
    for (const key of CLAUDE_AUTH_SETTING_KEYS) {
      if (parsed?.[key] !== undefined) auth[key] = parsed[key];
    }
    if (Object.keys(auth).length === 0) return;
    writeSecret(join(home, "settings.json"), JSON.stringify(auth, null, 2));
  } catch {
    // No settings.json, malformed JSON, or an unwritable home. None of those
    // are a reason to fail a launch, and the CLI has other paths to auth.
  }
}

/**
 * Grok Build, headless. There is no --mcp-config / --strict-mcp-config: MCP
 * servers come from config.toml. We give the process its own GROK_HOME so
 * the user's ~/.grok servers and plugins are not loaded, write boxaide as
 * the only server there, and pre-approve read/draft tools under dontAsk
 * (anything else, including message_send, is a silent denial).
 *
 * Claude/Cursor MCP entries in ~/.claude.json still appear in `grok inspect`
 * even with GROK_HOME set; the env flags below mark them disabled. Plugin
 * MCP servers Grok discovers from ~/.claude/plugins cannot be turned off
 * from here — the allowlist is the boundary that still holds.
 */
/**
 * Grok's config home lives inside the launch's own working directory, so two
 * overlapping automation runs never share one.
 *
 * Safe to make per-launch because nothing in this home survives a launch that
 * mattered: `grokPrepare` rewrites config.toml and trusted_folders.toml from
 * scratch every time, and auth.json is a link to the user's real one. Claude's
 * home is shared for the opposite reason — see claudeConfigHomeFor.
 *
 * trusted_folders.toml is the reason this cannot stay shared: its content names
 * the working directory, so a second run writing its own path would untrust the
 * directory the first run is sitting in.
 */
function grokHomeFor(workDir: string): string {
  return join(workDir, "grok-home");
}

function grokArgs(ctx: LaunchContext, model?: string): string[] {
  return [
    ...grokArgsFor(kickoffPrompt(ctx), chatPreapprovedToolNames(), {
      // Boxaide's own web_search is what the chat agent should reach for, so
      // the CLI's index stays off while a search connector exists. With none
      // configured there is nothing to prefer, and Grok keeps its own.
      disableWebSearch: !nativeWebAllowed(ctx),
      model,
    }),
    // Same reason as Claude's stream-json, same chat-only rule. Grok's ACP
    // session updates include one tool_call line per call.
    "--output-format",
    "streaming-json",
  ];
}

function grokRunArgs(
  _ctx: LaunchContext,
  prompt: string,
  // Grok names no per-launch path on its command line: its MCP config and its
  // trusted-folder list both live in GROK_HOME, which is already per-launch.
  _workDir: string,
  model?: string,
): string[] {
  // Spec (Scheduler): the CLI's own web tools stay at the CLI's defaults on a
  // run — we neither grant nor deny them. An automation that must look
  // something up is exactly the case --disable-web-search would break, and
  // the chat path's flag was inherited here by accident.
  return grokArgsFor(prompt, runPreapprovedToolNames(), {
    disableWebSearch: false,
    model,
  });
}

function grokArgsFor(
  prompt: string,
  allowed: readonly string[],
  opts: { disableWebSearch: boolean; model?: string },
): string[] {
  const args = [
    "-p",
    prompt,
    "--verbatim",
    "--permission-mode",
    "dontAsk",
    "--no-subagents",
    "--no-plan",
    "--no-memory",
    ...(opts.disableWebSearch ? ["--disable-web-search"] : []),
    ...(opts.model ? ["--model", opts.model] : []),
  ];
  for (const name of allowed) {
    args.push("--allow", `MCPTool(boxaide__${name})`);
  }
  return args;
}

function grokChildEnv(ctx: LaunchContext, workDir: string): Record<string, string> {
  return {
    GROK_HOME: grokHomeFor(workDir),
    BOXAIDE_TOKEN: ctx.bearerToken,
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CURSOR_MCPS_ENABLED: "0",
    GROK_CLAUDE_SKILLS_ENABLED: "0",
    GROK_CURSOR_SKILLS_ENABLED: "0",
    GROK_CLAUDE_HOOKS_ENABLED: "0",
    GROK_CURSOR_HOOKS_ENABLED: "0",
    GROK_CLAUDE_RULES_ENABLED: "0",
    GROK_CURSOR_RULES_ENABLED: "0",
    GROK_CLAUDE_AGENTS_ENABLED: "0",
    GROK_CURSOR_AGENTS_ENABLED: "0",
  };
}

function grokPrepare(
  ctx: LaunchContext,
  workDir: string,
  parentEnv: NodeJS.ProcessEnv,
): void {
  const home = grokHomeFor(workDir);
  mkdirSync(home, { recursive: true });

  let trusted = workDir;
  try {
    trusted = realpathSync(workDir);
  } catch {
    // The directory was just created; the unresolved path is still the cwd.
  }

  writeSecret(join(home, "config.toml"), grokConfigToml(ctx));
  writeSecret(join(home, "trusted_folders.toml"), grokTrustToml(trusted));

  // If GROK_HOME is ignored, project config in the empty workdir still
  // declares boxaide. Same name as the isolated user server, so it does
  // not stack a second copy when both are read.
  const projectGrok = join(workDir, ".grok");
  mkdirSync(projectGrok, { recursive: true });
  writeSecret(join(projectGrok, "config.toml"), grokProjectToml(ctx));

  const parentHome = parentEnv.GROK_HOME || join(homedir(), ".grok");
  const authFrom = join(parentHome, "auth.json");
  if (existsSync(authFrom)) {
    refreshLink(authFrom, join(home, "auth.json"));
  }
}

function grokConfigToml(ctx: LaunchContext): string {
  return [
    "[cli]",
    "auto_update = false",
    "",
    "[compat.claude]",
    "mcps = false",
    "skills = false",
    "rules = false",
    "agents = false",
    "hooks = false",
    "",
    "[compat.cursor]",
    "mcps = false",
    "skills = false",
    "rules = false",
    "agents = false",
    "hooks = false",
    "",
    "[mcp_servers.boxaide]",
    `url = ${tomlString(ctx.mcpUrl)}`,
    `bearer_token_env_var = ${tomlString("BOXAIDE_TOKEN")}`,
    "",
  ].join("\n");
}

function grokProjectToml(ctx: LaunchContext): string {
  return [
    "[mcp_servers.boxaide]",
    `url = ${tomlString(ctx.mcpUrl)}`,
    `bearer_token_env_var = ${tomlString("BOXAIDE_TOKEN")}`,
    "",
  ].join("\n");
}

function grokTrustToml(workDir: string): string {
  return `[folders.${tomlString(workDir)}]\ntrusted = true\n`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function refreshLink(from: string, to: string): void {
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
 * a window where the file exists and is empty or partial — rare, silent, and
 * exactly the kind of failure that only appears once runs can overlap.
 */
function writeSecret(path: string, content: string): void {
  const temp = tempPathFor(path);
  writeFileSync(temp, content, { mode: 0o600 });
  // writeFile preserves an existing file's mode; force the invariant even if an
  // earlier build or local user created it more broadly.
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** The same staging, for a file whose content comes from another file. */
function copySecret(from: string, to: string): void {
  const temp = tempPathFor(to);
  copyFileSync(from, temp);
  chmodSync(temp, 0o600);
  renameSync(temp, to);
}

/**
 * A staging path beside the target — same directory, so the rename stays on one
 * filesystem. The pid and counter keep two launches in one process, or two
 * processes over one data directory, off each other's staging file.
 */
let tempCounter = 0;
function tempPathFor(path: string): string {
  return `${path}.${process.pid}.${tempCounter++}.tmp`;
}

/**
 * Antigravity (agy), headless.
 *
 * It has no --allowedTools and no --mcp-config, which is exactly why it was
 * listed as "not launchable" before the server learned scopes: the only way to
 * run it unattended is --dangerously-skip-permissions, and that used to mean
 * handing the master bearer to a process that would approve anything asked of
 * it. The scoped token is what makes that flag safe — "skip permissions" now
 * means "skip asking about tools the server has already decided this launch
 * may call", and the ones it may not are refused whatever the CLI approves.
 */
function antigravityArgs(ctx: LaunchContext, model?: string): string[] {
  return [
    "-p",
    kickoffPrompt(ctx),
    // Without this agy does not read the .agents/ directory it is standing in,
    // and Boxaide's server is simply absent from the session — verified
    // against agy: the same launch lists the server only when the directory is
    // named here.
    "--add-dir",
    agentWorkDir(ctx.dataDir),
    "--dangerously-skip-permissions",
    // The user's own slash commands and skills are not part of a session
    // Boxaide is responsible for.
    "--disable-slash-commands",
    "--output-format",
    "stream-json",
    ...(model ? ["--model", model] : []),
  ];
}

function antigravityRunArgs(
  _ctx: LaunchContext,
  prompt: string,
  workDir: string,
  model?: string,
): string[] {
  return [
    "-p",
    prompt,
    "--add-dir",
    workDir,
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    ...(model ? ["--model", model] : []),
  ];
}

/**
 * agy reads MCP servers from `.agents/mcp_config.json` in the directory it
 * starts in, on top of the user's own `~/.gemini/config/mcp_config.json`.
 *
 * This adds Boxaide to that set; it cannot subtract the user's servers, and
 * there is no flag or environment variable that isolates them (verified
 * against agy's own help and its embedded configuration docs). That is a
 * limitation of this CLI, not a hole in Boxaide's boundary: the user's other
 * servers can no more reach Boxaide's mail than any other program on the
 * machine, and what this agent may do with Boxaide's own tools is decided by
 * the scoped token, not by which servers it can see.
 */
function antigravityPrepare(ctx: LaunchContext, workDir: string): void {
  const agentsDir = join(workDir, ".agents");
  mkdirSync(agentsDir, { recursive: true });
  writeSecret(
    join(agentsDir, "mcp_config.json"),
    JSON.stringify(
      {
        mcpServers: {
          boxaide: {
            serverUrl: ctx.mcpUrl,
            headers: { Authorization: `Bearer ${ctx.bearerToken}` },
          },
        },
      },
      null,
      2,
    ),
  );
}

/**
 * True when this entry from the user's agy config reaches this Boxaide.
 *
 * The name is checked because Boxaide's own connect snippet uses it and
 * because a same-named entry shadows the one a launch writes. The URL is
 * checked because the name is the user's to choose: `/api/agent-connect` hands
 * out a URL and an Authorization header with no server name attached, so the
 * entry that carries the master bearer is as likely to be called "mail" as
 * "boxaide" — and agy merges every non-colliding server rather than replacing
 * them, so a differently-named one sits beside the scoped connection and can
 * send mail.
 *
 * Matched on port and path against `ctx.mcpUrl`, with a loopback host: that is
 * what makes it this server rather than some other MCP server the user runs.
 */
function reachesBoxaide(name: string, entry: unknown, mcpUrl: string): boolean {
  if (name.toLowerCase() === "boxaide") return true;
  const raw = (entry as { url?: unknown; serverUrl?: unknown }) ?? {};
  const candidate = typeof raw.url === "string" ? raw.url : raw.serverUrl;
  if (typeof candidate !== "string") return false;
  let declared: URL;
  let ours: URL;
  try {
    declared = new URL(candidate);
    ours = new URL(mcpUrl);
  } catch {
    return false;
  }
  const local = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
  if (!local.has(declared.hostname.toLowerCase())) return false;
  return declared.port === ours.port && declared.pathname === ours.pathname;
}

/**
 * agy reads MCP servers from `~/.gemini/config/mcp_config.json` as well as the
 * workspace, and on a name collision the user's file wins — verified: a
 * launch whose workspace declared `boxaide` reached the server named in the
 * user's file instead, with the credential written there. Entries that do not
 * collide are merged in rather than replaced, so a user entry under any other
 * name is a second, unscoped connection to the same server.
 *
 * Boxaide's own connect dialog tells users to paste exactly such an entry, and
 * it carries the master bearer. So on a machine that followed those
 * instructions, a launched agy would hold the unscoped credential no matter
 * what this launcher mints — the one case where the scope could be bypassed.
 *
 * There is no flag that disables the user's file (checked agy's help and its
 * embedded configuration docs) and no home directory override that keeps the
 * CLI signed in. So the launch is refused, with the one-line fix, rather than
 * started on a credential Boxaide did not issue.
 */
function antigravityPreflight(
  ctx: LaunchContext,
  env: NodeJS.ProcessEnv,
): string | null {
  const path = join(env.HOME || homedir(), ".gemini", "config", "mcp_config.json");
  let declared: unknown;
  try {
    declared = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // No file, or one this cannot read as JSON. Nothing shadows Boxaide's own
    // entry, which is the only thing being checked here.
    return null;
  }
  const servers = (declared as { mcpServers?: Record<string, unknown> })?.mcpServers;
  if (!servers || typeof servers !== "object") return null;
  const found = Object.entries(servers).find(([name, entry]) =>
    reachesBoxaide(name, entry, ctx.mcpUrl),
  );
  if (!found) return null;
  return `Antigravity is configured with its own Boxaide server in ${path}, under the name "${found[0]}" — the agent would reach Boxaide through that entry, on the credential written there, instead of the limited one Boxaide issues for a launch. Remove the "${found[0]}" entry from that file and start again; Boxaide wires the connection itself now, so nothing else is needed.`;
}

/** `agy models` prints "id<TAB>Label" for everything the account can reach. */
const ANTIGRAVITY_LISTER: ModelLister = {
  args: ["models"],
  parse: parseTabbedModels,
};

/**
 * OpenCode, headless.
 *
 * `run` ignores spawn cwd and walks to a git checkout (observed: it left the
 * empty workdir and opened this repo). --dir pins it. Global
 * ~/.config/opencode/opencode.json is merged unless XDG_CONFIG_HOME is
 * elsewhere, and that file on a real machine starts the user's other MCP
 * servers. Auth stays in the default data dir so the process still has keys.
 */
function opencodeHomeFor(ctx: LaunchContext): string {
  return join(agentRoot(ctx.dataDir), "agent-homes", "opencode");
}

/**
 * Pin a model even when the user picked none. OpenCode's own default retries
 * forever when that endpoint is down, and the pane then waits for a
 * chat_await_message that never comes.
 */
const OPENCODE_DEFAULT_MODEL = "opencode/big-pickle";

/**
 * Chat launch: the server, not a one-shot `run`.
 *
 * `run` answers once and exits, so the loop only exists for as long as the
 * model keeps choosing to call chat_await_message. The server has no such
 * opinion — it stays up and the driver holds the loop (see opencode-driver.ts).
 * The port is 0 and read back off stdout, since a port picked here can be taken
 * by the time the child binds. Errors are printed because a 500 from this
 * server carries only a reference id; the trace goes to stderr.
 */
function opencodeArgs(_ctx: LaunchContext, _model?: string): string[] {
  return [
    "--pure",
    "serve",
    "--port",
    "0",
    "--hostname",
    "127.0.0.1",
    "--print-logs",
    "--log-level",
    "ERROR",
  ];
}

function opencodeDrive(
  ctx: LaunchContext,
  opts: DriveOptions,
): AgentDriver | null {
  // Without a channel there is nobody to drive for: the launcher still runs
  // the server, and the MCP tier is unaffected.
  if (!ctx.channel) return null;
  // `args` is set on this spec, so the launcher always has a child here.
  if (!opts.child) return null;
  return new OpenCodeDriver({
    channel: ctx.channel,
    agent: "opencode",
    // Same block the Claude driver gets, read the same way: per prompt.
    memorySystem: () => chatMemoryBlock(ctx.dataDir),
    baseUrl: serveBaseUrl(opts.child),
    directory: opts.workDir,
    password: opts.childEnv.OPENCODE_SERVER_PASSWORD ?? null,
    model: opts.model ?? OPENCODE_DEFAULT_MODEL,
  }).start();
}

function opencodeRunArgs(
  _ctx: LaunchContext,
  prompt: string,
  workDir: string,
  model?: string,
): string[] {
  return [
    "--pure",
    "run",
    // Auto-approval, same reasoning as agy's skip-permissions: the boundary is
    // the scoped token, and a run has nobody to answer a prompt anyway.
    "--auto",
    "--dir",
    workDir,
    "--model",
    model ?? OPENCODE_DEFAULT_MODEL,
    prompt,
  ];
}

function opencodeChildEnv(
  ctx: LaunchContext,
  workDir: string,
): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(opencodeHomeFor(ctx), "config"),
    OPENCODE_CONFIG: join(workDir, "opencode.json"),
    // Loopback still means every local account, and this server executes
    // whatever it is prompted. A fresh secret per launch; the driver gets the
    // same env map the child was spawned with.
    OPENCODE_SERVER_PASSWORD: randomUUID(),
  };
}

/**
 * OpenCode creates four directories under the user's home before it will run,
 * and a denied mkdir there is fatal — verified: a confined `opencode --version`
 * failed on each of config, data, cache and state in turn until all four were
 * writable. Only config is redirected by `opencodeChildEnv`; the others hold
 * the auth that keeps the launch signed in, which is why they are not.
 *
 * XDG variables are read from the parent rather than assumed, so a machine
 * that moved them is described accurately instead of hopefully.
 */
function opencodeSandbox(
  _ctx: LaunchContext,
  _workDir: string,
  env: NodeJS.ProcessEnv,
): { write: string[] } {
  const home = env.HOME || homedir();
  const xdg = (name: string, fallback: string) =>
    join(env[name] || join(home, fallback), "opencode");
  return {
    write: [
      xdg("XDG_CONFIG_HOME", ".config"),
      xdg("XDG_DATA_HOME", ".local/share"),
      xdg("XDG_CACHE_HOME", ".cache"),
      xdg("XDG_STATE_HOME", ".local/state"),
    ],
  };
}

function opencodePrepare(ctx: LaunchContext, workDir: string): void {
  mkdirSync(join(opencodeHomeFor(ctx), "config"), { recursive: true });
  writeSecret(
    join(workDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: OPENCODE_DEFAULT_MODEL,
        mcp: {
          boxaide: {
            type: "remote",
            url: ctx.mcpUrl,
            enabled: true,
            oauth: false,
            timeout: 120_000,
            headers: { Authorization: `Bearer ${ctx.bearerToken}` },
          },
        },
      },
      null,
      2,
    ),
  );
}

/**
 * `opencode models` prints bare "provider/model" ids. --pure matches how the
 * launcher runs the CLI, so the list is what a launch would actually accept.
 */
const OPENCODE_LISTER: ModelLister = {
  args: ["--pure", "models"],
  parse: parseBareModels,
};

/**
 * Codex, headless.
 *
 * Like agy it has no per-tool allowlist flag, so it could not be launched
 * before the server carried the boundary. Unlike agy it isolates cleanly:
 * CODEX_HOME moves every piece of user config, and the MCP server is declared
 * in the config.toml this writes there rather than on the command line, which
 * keeps the credential out of process listings.
 *
 * The sandbox is left on (`workspace-write`) and only the approval prompt is
 * turned off. Boxaide's scope governs Boxaide's tools; it says nothing about
 * shell commands the model runs on the user's machine, and there is no reason
 * to widen those just because the agent is unattended.
 */
function codexHomeFor(workDir: string): string {
  return join(workDir, "codex-home");
}

function codexArgs(ctx: LaunchContext, model?: string): string[] {
  return codexArgsFor(kickoffPrompt(ctx), model);
}

function codexRunArgs(
  _ctx: LaunchContext,
  prompt: string,
  _workDir: string,
  model?: string,
): string[] {
  return codexArgsFor(prompt, model);
}

function codexArgsFor(prompt: string, model?: string): string[] {
  return [
    "exec",
    // The workdir is not a git checkout, and codex refuses to start outside
    // one without this.
    "--skip-git-repo-check",
    // Auto-approval that keeps the workspace-write sandbox on. Verified
    // against codex 0.147: with any other combination of approval_policy and
    // sandbox mode short of --dangerously-bypass-approvals-and-sandbox, every
    // MCP call comes back "user cancelled MCP tool call" — there is nobody to
    // ask — and the run looks alive while doing nothing. This is the only
    // setting that approves the calls without also turning the sandbox off.
    "--approve-for-me",
    "--json",
    ...(model ? ["--model", model] : []),
    // Last, and behind nothing else that takes a value: the prompt is a
    // positional argument, and a message opening with a dash would otherwise
    // be read as options.
    "--",
    prompt,
  ];
}

/**
 * The auth file `codexPrepare` links into the isolated home lives in the
 * user's own `~/.codex`, and a symlink is only as writable as its target. The
 * binary usually sits under that same root, but not when it was installed by a
 * package manager — so it is named rather than assumed.
 *
 * Write, not read. A signed-in CLI does not hold a token forever: it refreshes
 * one and saves the new one, and a refresh that cannot save fails the sign-in
 * outright. Read-only here is what made a confined agent unable to
 * authenticate — see `antigravitySandbox` for the case that surfaced it.
 */
function codexSandbox(
  _ctx: LaunchContext,
  _workDir: string,
  env: NodeJS.ProcessEnv,
): { write: string[] } {
  return { write: [env.CODEX_HOME || join(env.HOME || homedir(), ".codex")] };
}

function codexChildEnv(
  _ctx: LaunchContext,
  workDir: string,
): Record<string, string> {
  return {
    CODEX_HOME: codexHomeFor(workDir),
    BOXAIDE_TOKEN: _ctx.bearerToken,
  };
}

/**
 * Codex is prepared once per launch and cannot see, from here, whether that
 * launch is the chat agent or a scheduled run — so the config it writes has to
 * carry the widest scope either could hold, and the narrowing that matters
 * stays with the token. `enabled_tools` is a hint, not the boundary.
 */
function codexPrepare(
  ctx: LaunchContext,
  workDir: string,
  parentEnv: NodeJS.ProcessEnv,
): void {
  const allowed = chatPreapprovedToolNames();
  const home = codexHomeFor(workDir);
  mkdirSync(home, { recursive: true });
  writeSecret(join(home, "config.toml"), codexConfigToml(ctx, allowed));
  // Auth lives in CODEX_HOME, and moving the home moves it. Linked from the
  // user's real one, exactly as Grok's is, so an isolated launch is still
  // signed in.
  const parentHome = parentEnv.CODEX_HOME || join(homedir(), ".codex");
  const authFrom = join(parentHome, "auth.json");
  if (existsSync(authFrom)) refreshLink(authFrom, join(home, "auth.json"));
}

function codexConfigToml(ctx: LaunchContext, allowed: readonly string[]): string {
  return [
    "[mcp_servers.boxaide]",
    `url = ${tomlString(ctx.mcpUrl)}`,
    `bearer_token_env_var = ${tomlString("BOXAIDE_TOKEN")}`,
    // Codex's own copy of the scope, for the same reason Claude gets
    // --allowedTools: a refusal here costs no round trip. The server is still
    // what enforces it.
    `enabled_tools = [${allowed.map(tomlString).join(", ")}]`,
    "",
  ].join("\n");
}

/** Same as codex: grok's linked `auth.json` points back into the user's home. */
function grokSandbox(
  _ctx: LaunchContext,
  _workDir: string,
  env: NodeJS.ProcessEnv,
): { write: string[] } {
  return { write: [env.GROK_HOME || join(env.HOME || homedir(), ".grok")] };
}

/**
 * agy keeps its sign-in under `~/.gemini`, and unlike the others that home
 * cannot be moved — which is the same reason `antigravityPreflight` exists.
 *
 * Writable, and this is the CLI that proved why. Confined with `~/.gemini`
 * readable but not writable, agy starts, tries to establish its session, has
 * nowhere to put the result, waits, and exits — with no error the user ever
 * sees. The agent simply never picked the message up. Every CLI here signs in
 * by writing something down; none of them can do it read-only.
 */
function antigravitySandbox(
  _ctx: LaunchContext,
  _workDir: string,
  env: NodeJS.ProcessEnv,
): { write: string[] } {
  return { write: [join(env.HOME || homedir(), ".gemini")] };
}

/** `grok models` prints a bullet list under a prose header. */
const GROK_LISTER: ModelLister = { args: ["models"], parse: parseBulletModels };

/**
 * The `claude` CLI has no listing command — `claude --help` documents --model
 * but nothing enumerates it, and `claude models` just starts a session with
 * "models" as the prompt. So this one list stays typed out, and it is the only
 * one: every other agent reads its models from its own CLI.
 */
const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

/**
 * The agent-owned subtree — `agentRoot`/`agentWorkDir`, and why it sits
 * outside the data directory — is defined in ./paths.ts and shared with the
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

export const KNOWN_AGENTS: AgentSpec[] = [
  {
    // No `args`: there is nothing to keep running. The driver spawns one
    // `claude -p` per user turn and resumes the session across them, so the
    // conversation cannot end because a model decided it was done.
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    runArgs: claudeRunArgs,
    models: CLAUDE_MODELS,
    childEnv: claudeChildEnv,
    prepare: claudePrepare,
    renderRunLine: renderClaudeRunLine,
    drive: claudeDrive,
  },
  {
    id: "grok",
    label: "Grok",
    bin: "grok",
    args: grokArgs,
    runArgs: grokRunArgs,
    listModels: GROK_LISTER,
    childEnv: grokChildEnv,
    prepare: grokPrepare,
    sandbox: grokSandbox,
    readEvent: readGrokEvent,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    bin: "agy",
    args: antigravityArgs,
    runArgs: antigravityRunArgs,
    listModels: ANTIGRAVITY_LISTER,
    prepare: antigravityPrepare,
    sandbox: antigravitySandbox,
    preflight: antigravityPreflight,
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    args: opencodeArgs,
    runArgs: opencodeRunArgs,
    listModels: OPENCODE_LISTER,
    childEnv: opencodeChildEnv,
    prepare: opencodePrepare,
    sandbox: opencodeSandbox,
    readEvent: readOpenCodeEvent,
    drive: opencodeDrive,
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    args: codexArgs,
    runArgs: codexRunArgs,
    childEnv: codexChildEnv,
    prepare: codexPrepare,
    sandbox: codexSandbox,
  },
];

/** A spec this build knows how to start: a child to spawn, a driver, or both. */
function launchable(spec: AgentSpec): boolean {
  return spec.args !== undefined || spec.drive !== undefined;
}

/**
 * A spec whose whole launch is its driver: no argv, so nothing is spawned here
 * and the driver's lifetime is the agent's.
 */
function drivenOnly(spec: AgentSpec): boolean {
  return spec.args === undefined && spec.drive !== undefined;
}

export type ListedAgent = {
  id: string;
  label: string;
  /** The binary exists on PATH. */
  available: boolean;
  /** This build knows how to launch it. */
  supported: boolean;
  /** This build can carry a scheduled automation run on it. */
  runsAutomations: boolean;
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
 * code null — so a UI reading the code alone painted "Stop" as a crash on one
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
};

export type OneShotOptions = {
  /**
   * The run row's id. Identifies this run among the ones alive beside it, and
   * names the directory it works in, so it must be a plain id — letters,
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
 * Armed only for specs with `renderRunLine` — a spec whose runArgs asked its
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
 * a detached grandchild can hold one open for as long as it likes — that is
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
  return `[boxaide] network: refused ${hosts.join(", ")}${extra} — a scheduled run reaches its model provider and Boxaide, nothing else. Add a host with BOXAIDE_RUN_NETWORK_ALLOW if the CLI needs it.`;
}

/**
 * Written into a confined run's log before the CLI says anything.
 *
 * Refusals are only recorded for connections that came through the proxy. A
 * CLI that ignores the proxy variables goes straight at the network, is
 * refused by the sandbox instead, and reports whatever a connection error
 * looks like to it — with nothing of ours in the log to explain it. So the
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
   * cache and refreshes in the background — this endpoint is polled every few
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
          available: bin !== null,
          supported: launchable(spec),
          runsAutomations: spec.runArgs !== undefined,
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
    // A listing that throws must not fail the endpoint — it is the same
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
    // `answered` is what separates "never asked" from "asked, got nothing" —
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
   * after any await that precedes the spawn — `this.running` is only
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
   * the user's own home produces a login no launch can see — the sign-in
   * button then "works" every time and fixes nothing.
   */
  claudeConfigHome(): string {
    return claudeConfigHomeFor(this.ctx);
  }

  /**
   * The model the last chat launch of this agent used, or null for the CLI's
   * own default. Kept past the exit so a relaunch the user did not press Start
   * for — the one after a sign-in lands — restores what they had picked.
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
    if (!launchable(spec)) {
      throw new LaunchError(400, `${spec.label} cannot be launched yet`);
    }
    const bin = this.resolveBin(spec.bin);
    if (!bin) {
      throw new LaunchError(400, `${spec.label} is not installed (no ${spec.bin} on PATH)`);
    }
    const blocked = spec.preflight?.(this.ctx, this.env);
    if (blocked) throw new LaunchError(400, blocked);
    // A driven-only launch IS its driver, and a driver with no channel declines.
    // Refuse here rather than report a running agent that does nothing.
    if (drivenOnly(spec) && !this.ctx.channel) {
      throw new LaunchError(400, `${spec.label} needs the Boxaide conversation`);
    }
    // The model id becomes an argv element, so it must be one the CLI itself
    // named — the same allowlist rule that protects the agent id, now sourced
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

    // A driven spec's model does not run the chat loop — its driver does — so
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

    this.child = child;
    this.running = started;
    this.lastModels.set(spec.id, model ?? null);
    // Held so every path that ends this launch — a child exit, a driver giving
    // up, Stop, shutdown — takes the credential back. noteExit is the one
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
   * Refuses at capacity rather than queueing internally — the scheduler owns
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
    try {
      const spec = this.resolveRunSpec(opts.agentId);
      const bin = this.resolveBin(spec.bin);
      if (!bin) {
        throw new LaunchError(
          400,
          `${spec.label} is not installed (no ${spec.bin} on PATH)`,
        );
      }
      const blocked = spec.preflight?.(this.ctx, this.env);
      if (blocked) throw new LaunchError(400, blocked);
      const model = opts.model ?? undefined;
      if (model !== undefined) {
        // The model id becomes an argv element, so it must be one the CLI
        // itself named — the same rule `start` applies to a chat launch.
        const offered = await this.modelsFor(spec, bin);
        if (!offered.some((m) => m.id === model)) {
          throw new LaunchError(400, `${spec.label} does not offer that model`);
        }
      }
      // That listing is the only suspension point before the spawn, and a
      // close() landing inside it would otherwise be followed by a run
      // starting anyway. Same re-check start() makes for the same reason.
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
      // An unconfined install keeps what it had — with no sandbox there is
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
      // No child, so nothing else will ever release this reservation — or the
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
    if (egress) note(egressActiveNote(egressAllow));

    // Which status a kill produces. A deadline or a manual kill is 'killed';
    // the watchdog is 'error', because a run that never spoke did not start.
    let forced: "killed" | "error" | null = null;

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
      // stdout only. stderr carries startup noise from things that are not the
      // session — a CLI's update check can feed a timer the agent never did.
      // First chunk is enough: mid-tool silence is healthy, so do not re-arm.
      if (waiting) {
        clearTimeout(waiting);
        waiting = null;
      }
      if (split) split(chunk);
      else capture(chunk);
    });
    // stderr stays raw whatever the spec does: a crash writes plain text here.
    child.stderr?.on("data", capture);

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
        // Already being killed — by the deadline, the watchdog, or an earlier
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
        // proxy goes with it, and what it turned away goes in the log — a run
        // that failed because its CLI needed a host nobody listed must say so,
        // or the boundary is indistinguishable from a broken install.
        grant?.revoke();
        const refused = egress?.refusals() ?? [];
        const refusedTotal = egress?.refusedTotal() ?? 0;
        egress?.stop();
        if (refused.length > 0) note(egressRefusedNote(refused, refusedTotal));
        // The slot is freed before the directory is removed: a failure to clean
        // up disk must not cost this launcher a run slot for the rest of the
        // process's life.
        this.oneShots.delete(opts.runId);
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // Left for the sweep at the next start.
        }
        resolve({
          status: forced ?? (code === 0 ? "ok" : "error"),
          exitCode: code,
          log,
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
      // grandchild can hold one open long after the agent is gone — that is
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
   * connected over MCP is not this process's to kill — there is no child here
   * to signal — and false is what tells the route to say so.
   */
  interrupt(seq: number): boolean {
    return this.driver?.interrupt?.(seq) ?? false;
  }

  /** Idempotent: stopping with nothing running is a no-op. */
  stop(): void {
    this.stopRequested = true;
    // The child is captured before the driver is stopped, for the same reason
    // close() clears its state first: a driver may report the end of its loop
    // from inside its own stop(), which reaches noteExit and nulls `this.child`
    // — and a long-lived child read after that line would never be signalled.
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
   * The workdir a listing is described against — prepared, so the config files
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
   * which never opens an MCP connection — but preparing the workdir writes a
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
   * Every spawn goes through here — the chat child, each run's child, and (via
   * `DriveOptions.command`) every turn a driver starts. That is the same shape
   * as the tool scope: one place decides, and a spec cannot opt out of it.
   *
   * Writable: the launch's own directory and the agent root, which holds the
   * CLI config homes that are shared across launches. Denied last: the data
   * directory, whatever else named it.
   */
  private confine(
    spec: AgentSpec,
    bin: string,
    workDir: string,
    access: AgentAccess,
    network: NetworkAccess = "open",
  ): LaunchCommand {
    if (access === "full") return plainCommand(bin);
    const extra = spec.sandbox?.(this.ctx, workDir, this.env) ?? {};
    return confineCommand({
      bin,
      access,
      network,
      write: [workDir, agentRoot(this.ctx.dataDir), ...(extra.write ?? [])],
      // The credential and the mail store. `:memory:` names no directory, so
      // there is nothing on disk to keep the agent out of.
      deny: this.ctx.dataDir === ":memory:" ? [] : [this.ctx.dataDir],
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
   * Which CLI carries a run. A null agentId means "first available", which is
   * resolved in registry order against what is actually installed — an
   * automation saved on a machine that later loses that CLI still runs.
   */
  private resolveRunSpec(agentId?: string | null): AgentSpec {
    if (agentId) {
      const spec = this.registry.find((s) => s.id === agentId);
      if (!spec) throw new LaunchError(404, `unknown agent: ${agentId}`);
      if (!spec.runArgs) {
        throw new LaunchError(400, `${spec.label} cannot run automations yet`);
      }
      return spec;
    }
    const found = this.registry.find(
      (s) =>
        s.runArgs !== undefined &&
        this.resolveBin(s.bin) !== null &&
        // "First available" must mean first that can actually run: an agent
        // its preflight would refuse is not a candidate, or every scheduled
        // run on that machine would fail on the same message.
        !s.preflight?.(this.ctx, this.env),
    );
    if (!found) {
      throw new LaunchError(400, "no agent CLI is installed to run automations");
    }
    return found;
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
    // Everything that can call back into this method is cleared FIRST. A driver
    // is free to report the end of its loop from inside its own stop(), and that
    // arrives here as another exit for the same agent — which would recurse
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

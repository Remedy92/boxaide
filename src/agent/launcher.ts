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
 *  - Read, draft and platform (CRM / automation / outreach) tools are
 *    pre-approved. `message_send` is NOT in the
 *    allowlist, so a launched agent that tries to send hits the client's own
 *    permission wall, which in headless mode is a denial.
 *  - One CHAT agent at a time. The channel hands each user message to exactly
 *    one waiter; a second launched chat agent would race it for every message.
 *    Automation runs are separate and may overlap — see `runOnce` and
 *    docs/specs/agent-platform.md invariant 4.
 */
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
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  lineSplitter,
  readGrokEvent,
  renderClaudeRunLine,
  type ReadEvent,
  type RenderRunLine,
} from "./agent-stream.js";
import { ClaudeDriver, type ClaudeTurnRequest } from "./claude-driver.js";
import type { AgentDriver, DriverChannel } from "./driver.js";
import {
  fetchModels,
  parseBulletModels,
  type ModelLister,
  type ModelOption,
} from "./model-list.js";
import { CRM_TOOL_NAMES } from "../crm/tools.js";
import { AUTOMATION_TOOL_NAMES } from "../automation/tools.js";
import { OUTREACH_TOOL_NAMES } from "../outreach/tools.js";
import {
  CALENDAR_READ_TOOL_NAMES,
  CALENDAR_SEND_TOOL_NAMES,
} from "../calendar/tools.js";

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
const KICKOFF = `You are my Boxaide inbox agent. Use the Boxaide MCP tools.

Loop: call chat_await_message, do the work, post the answer with chat_say, then
call chat_await_message again. Keep going until I tell you to stop.

Everything I read appears in the Boxaide window, so every answer must go through
chat_say — do not answer here. A chat_await_message that returns no message is
normal; call it again. Use chat_activity for anything slow. Draft rather than
send unless I ask you to send.`;

/**
 * Every Boxaide tool except message_send. Deliberately a hand-written
 * allowlist and not "TOOLS minus send": adding a new server tool must not
 * silently pre-approve it here. Each CLI namespaces these differently.
 */
const PREAPPROVED_TOOL_NAMES = [
  "accounts_list",
  "messages_list",
  "messages_search",
  "message_get",
  "message_mark_read",
  "draft_create",
  "draft_update",
  "drafts_list",
  "draft_delete",
  "folders_list",
  "chat_await_message",
  "chat_say",
  "chat_activity",
  "chat_history",
];


/**
 * The chat loop's own tools: taking a message, answering it, narrating it.
 *
 * A driven session must not have these — the driver holds the lease, and a
 * second asker on one channel answers twice. A scheduled run must not either:
 * it has nobody to talk to.
 */
const LOOP_TOOL_NAMES = new Set(["chat_await_message", "chat_say", "chat_activity"]);

/**
 * Reading the conversation back. Not a loop tool: it takes no lease and posts
 * nothing, and it is the only way a driven session that lost its own transcript
 * can recover what was already said. A scheduled run still does not get it —
 * the chat is the user's, and a run has no part in it.
 */
const HISTORY_TOOL_NAME = "chat_history";

const CHAT_TOOL_NAMES = new Set([...LOOP_TOOL_NAMES, HISTORY_TOOL_NAME]);

/**
 * Prepended verbatim to every automation prompt (spec: Scheduler / Run
 * preamble). It states the two boundaries the allowlist also enforces —
 * no chat, no sending — because a model that understands why it is being
 * refused writes a draft instead of retrying the wall.
 */
export const AUTOMATION_RUN_PREAMBLE =
  "You are a scheduled Boxaide automation. Do the task below using the Boxaide MCP tools, then exit. You cannot talk to the user: do not call chat tools; write nothing to the user. Never send email: queue outreach with outbox_queue_draft or save with draft_create and a human will review.";

/** Automation tools a run may call: reads only. It must not edit the schedule. */
const RUN_AUTOMATION_READ_TOOLS = ["automations_list", "automation_runs_list"];

/**
 * The one allowlist builder both spawn paths go through.
 *
 * Interactive and scheduled agents used to compute their allowlists
 * separately, and drifted: the chat agent never got the platform tools, so
 * "ask the agent to create an automation" — which the Automations UI tells
 * users to do — hit the permission wall. Both paths derive from the same
 * sources here so they cannot drift again.
 *
 * The mail/chat base list stays hand-written above; only the platform lists
 * are derived from their owning modules. Computed per call rather than frozen
 * at import, so the result is honest about those sets at spawn time.
 * The sending tools — message_send, meeting_create, meeting_cancel — are
 * deleted last, unconditionally: the one rule that survives any future
 * addition to any of these sets.
 */
function preapprovedToolNames(opts: {
  /**
   * How much of the conversation this agent may touch: the whole loop (its own
   * model runs it), reading it back only (a driver runs it), or none of it (a
   * scheduled run has no user).
   */
  chat: "loop" | "history" | "none";
  /** A run may read the schedule; only the chat agent may edit it. */
  automation: "all" | "read";
}): string[] {
  const names = new Set<string>();
  for (const name of PREAPPROVED_TOOL_NAMES) {
    if (!CHAT_TOOL_NAMES.has(name)) names.add(name);
    else if (opts.chat === "loop") names.add(name);
    else if (opts.chat === "history" && name === HISTORY_TOOL_NAME) names.add(name);
  }
  for (const name of CRM_TOOL_NAMES) names.add(name);
  for (const name of AUTOMATION_TOOL_NAMES) {
    if (opts.automation === "all" || RUN_AUTOMATION_READ_TOOLS.includes(name)) {
      names.add(name);
    }
  }
  for (const name of OUTREACH_TOOL_NAMES) names.add(name);
  // Reads only, both paths. meeting_create and meeting_cancel mail every
  // attendee the moment they are called, so they stay off the allowlist and
  // hit the permission prompt — the user sees the send before it happens.
  for (const name of CALENDAR_READ_TOOL_NAMES) names.add(name);
  // Deleted last and unconditionally, exactly like message_send: the loop
  // above already excludes them, and this is the line that stays true if some
  // future edit widens it. Without it a scheduled run could be handed a tool
  // that sends email, and AUTOMATION_RUN_PREAMBLE's "never send email" would
  // be a request rather than a fact.
  for (const name of CALENDAR_SEND_TOOL_NAMES) names.delete(name);
  names.delete("message_send");
  return [...names];
}

/** Pre-approved tools for a KICKOFF launch, whose model runs the chat loop. */
export function chatPreapprovedToolNames(): string[] {
  return preapprovedToolNames({ chat: "loop", automation: "all" });
}

/**
 * Pre-approved tools for a driven session: everything the chat agent gets
 * except the loop's own three.
 *
 * A driver already holds the lease. A model that could also call
 * chat_await_message would be a second asker on one channel — it could take the
 * message out from under the loop and answer it twice. `AgentChannel.setDriven`
 * refuses those calls at the server; leaving them off the allowlist means the
 * model never makes them.
 *
 * chat_history stays approved. It is lease-safe, the MCP server does not refuse
 * it for a driven session, and it is the recovery path when a refused resume
 * costs the session its memory: the model can read the conversation back instead
 * of answering the next message as a stranger.
 */
export function drivenPreapprovedToolNames(): string[] {
  return preapprovedToolNames({ chat: "history", automation: "all" });
}

/** Pre-approved tools for a headless automation run. */
export function runPreapprovedToolNames(): string[] {
  return preapprovedToolNames({ chat: "none", automation: "read" });
}

export type LaunchContext = {
  mcpUrl: string;
  bearerToken: string;
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
};

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
  workDir: string;
  model?: string;
  /** The full child environment, exactly as the launcher's own spawn built it. */
  env: NodeJS.ProcessEnv;
  /** The spec's own childEnv entries alone. Per-launch secrets ride here. */
  childEnv: Record<string, string>;
  /**
   * Reports the loop's end. For a spec with no `args` this is the only exit
   * there is — nothing else the launcher owns can close — so a driver that gave
   * up passes the reason and it becomes `lastExit`. Null means it was stopped.
   */
  onStop: (error: string | null) => void;
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
      agentWorkDir(ctx),
      model,
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
    bin: opts.bin,
    cwd: opts.workDir,
    env: opts.env,
    argsFor: (turn) => claudeTurnArgs(ctx, turn, opts.model),
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
  _ctx: LaunchContext,
  prompt: string,
  workDir: string,
  model?: string,
): string[] {
  return [
    ...claudeFlagsFor(
      runPreapprovedToolNames().map((name) => `mcp__boxaide__${name}`),
      workDir,
      model,
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
 */
function claudeFlagsFor(
  allowedTools: string[],
  workDir: string,
  model?: string,
): string[] {
  return [
    "-p",
    ...(model ? ["--model", model] : []),
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
    allowedTools.join(","),
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
  const root =
    ctx.dataDir === ":memory:" ? join(tmpdir(), "boxaide-agent") : ctx.dataDir;
  return join(root, "agent-homes", "claude");
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
  const parentHome = parentEnv.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  claudeCopyCredentials(parentHome, home);
  claudeWriteAuthSettings(parentHome, home);
}

/**
 * Auth is the one thing the isolated home must inherit.
 *
 * Copied per launch rather than symlinked: `claude` rewrites this file when it
 * refreshes a token, and through a symlink that write lands in the user's own
 * ~/.claude/.credentials.json — a process Boxaide is responsible for must not
 * edit the user's terminal auth. prepare runs before every spawn, so the copy
 * is at most one run stale. On macOS the credentials live in the keychain and
 * there is no file at all; then nothing is copied and the CLI finds its own.
 */
function claudeCopyCredentials(parentHome: string, home: string): void {
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

function grokArgs(_ctx: LaunchContext, model?: string): string[] {
  return [
    ...grokArgsFor(KICKOFF, chatPreapprovedToolNames(), {
      disableWebSearch: true,
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

/** The chat agent's working directory. One per install; it owns it alone. */
function agentWorkDir(ctx: LaunchContext): string {
  return ctx.dataDir === ":memory:"
    ? join(tmpdir(), "boxaide-agent")
    : join(ctx.dataDir, "agent-workdir");
}

/** Where every automation run's own directory is created. */
function runWorkDirRoot(ctx: LaunchContext): string {
  return join(agentWorkDir(ctx), "runs");
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
    readEvent: readGrokEvent,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    bin: "agy",
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
  },
  // Detected and shown, not launchable: these CLIs have no verified way to
  // enforce Boxaide's per-tool boundary. A full bearer plus global approval
  // would let an injected prompt send mail or mutate the platform.
  { id: "codex", label: "Codex", bin: "codex" },
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
 * The tail is what gets kept, not the head: a run that failed says why in its
 * last lines, and the interesting part of a run that succeeded is the summary
 * it prints at the end.
 */
const ONESHOT_LOG_LIMIT = 64 * 1024;

export class AgentLauncher {
  private child: ChildProcess | null = null;
  private running: RunningAgent | null = null;
  private lastExit: LastExit | null = null;
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

    const workDir = this.prepareWorkDir(spec);

    this.stderrTail = "";
    // Built once and shared with the driver: a spec's childEnv may mint a
    // per-launch secret, and the driver must see the exact value the child got.
    const childEnv = spec.childEnv?.(this.ctx, workDir) ?? {};
    const env = this.baseEnvWith(childEnv);
    // Null for a driven-only spec: its driver spawns one child per turn, and a
    // second long-lived process here would be an agent nobody prompts.
    const child = spec.args
      ? spawn(bin, spec.args(this.ctx, model), {
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
    };

    this.child = child;
    this.running = started;
    this.stopRequested = false;
    // Before the driver: the channel has to know a launched agent exists, or
    // the loop's first awaitUserTurn is stamped against nobody.
    this.ctx.onRunningChange?.(spec.id);
    try {
      this.driver =
        spec.drive?.(this.ctx, {
          child,
          bin,
          workDir,
          model,
          env,
          childEnv,
          onStop: (error) => this.noteDriverStop(spec.id, error),
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
    let child: ChildProcess;
    let render: RenderRunLine | undefined;
    let workDir: string;
    try {
      const spec = this.resolveRunSpec(opts.agentId);
      const bin = this.resolveBin(spec.bin);
      if (!bin) {
        throw new LaunchError(
          400,
          `${spec.label} is not installed (no ${spec.bin} on PATH)`,
        );
      }
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
      workDir = this.prepareWorkDir(spec, runWorkDir(this.ctx, opts.runId));
      const prompt = `${AUTOMATION_RUN_PREAMBLE}\n\n${opts.prompt}`;

      child = spawn(bin, spec.runArgs!(this.ctx, prompt, workDir, model), {
        cwd: workDir,
        env: this.childEnvFor(spec, workDir),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // No child, so nothing else will ever release this reservation.
      this.starting.delete(opts.runId);
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
  private prepareWorkDir(spec: AgentSpec, dir?: string): string {
    const workDir = dir ?? agentWorkDir(this.ctx);
    mkdirSync(workDir, { recursive: true });
    spec.prepare?.(this.ctx, workDir, this.env);
    return workDir;
  }

  /**
   * The workdir a listing is described against — prepared, so the config files
   * its env points at exist. Preparing is idempotent and writes the same
   * content a launch would, so doing it early costs nothing. A failure here is
   * not fatal to a listing: the CLI is asked anyway, against the bare path.
   */
  private listWorkDir(spec: AgentSpec): string {
    try {
      return this.prepareWorkDir(spec);
    } catch {
      return agentWorkDir(this.ctx);
    }
  }

  private childEnvFor(spec: AgentSpec, workDir: string): NodeJS.ProcessEnv {
    return this.baseEnvWith(spec.childEnv?.(this.ctx, workDir) ?? {});
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
      (s) => s.runArgs !== undefined && this.resolveBin(s.bin) !== null,
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
  private noteDriverStop(id: string, error: string | null): void {
    if (this.running?.id !== id) return;
    if (error) this.stderrTail = `${this.stderrTail}\n${error}`.trim();
    // No code: a loop is not a process, and inventing 0 or 1 for it is what made
    // a stopped driven agent read as clean and a stopped child-backed one read
    // as a crash. The reason is the fact; the code stays absent because there
    // was none.
    this.noteExit(id, { code: null, reason: error ? "error" : "stopped" });
  }

  private noteExit(
    id: string,
    exit: { code: number | null; reason: ExitReason },
  ): void {
    if (this.running?.id !== id) return;
    // Everything that can call back into this method is cleared FIRST. A driver
    // is free to report the end of its loop from inside its own stop(), and that
    // arrives here as another exit for the same agent — which would recurse
    // until the stack ran out if `running` and `driver` still pointed at the
    // launch being torn down.
    this.running = null;
    this.child = null;
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

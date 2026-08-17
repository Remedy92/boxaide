/**
 * Local agent launcher: Boxaide starts the agent, instead of waiting for one.
 *
 * MCP is client-driven, so the Agent view is silent until some client enters
 * the chat_await_message loop. For GUI clients (Claude Desktop) nothing can
 * automate that. For CLI agents there is no such wall: `claude -p` and
 * `grok -p` run headless, take their MCP servers (Claude on the command
 * line, Grok via an isolated GROK_HOME), and keep looping for as long as
 * the kickoff prompt tells them to. This module detects which known
 * agent CLIs are installed, and spawns exactly one of them wired to this
 * server.
 *
 * Security posture, decided by the user and enforced here:
 *  - Only binaries from the fixed registry below are ever spawned, resolved
 *    from PATH, with argv built entirely in this file. No request input
 *    reaches a command line.
 *  - Read, draft and platform (CRM / automation / outreach) tools are
 *    pre-approved. `message_send` is NOT in the
 *    allowlist, so a launched agent that tries to send hits the client's own
 *    permission wall, which in headless mode is a denial.
 *  - One agent at a time. The channel hands each user message to exactly one
 *    waiter; a second launched agent would race it for every message.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  lineSplitter,
  readClaudeEvent,
  readGrokEvent,
  readOpenCodeEvent,
  type ReadEvent,
} from "./agent-stream.js";
import {
  OpenCodeDriver,
  serveBaseUrl,
  type AgentDriver,
  type DriverChannel,
} from "./opencode-driver.js";
import {
  fetchModels,
  parseBareModels,
  parseBulletModels,
  parseTabbedModels,
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


/** The chat loop's own tools. A scheduled run has nobody to talk to. */
const CHAT_TOOL_NAMES = new Set([
  "chat_await_message",
  "chat_say",
  "chat_activity",
  "chat_history",
]);

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
  /** The chat loop's tools. Only an interactive agent has a user to talk to. */
  chat: boolean;
  /** A run may read the schedule; only the chat agent may edit it. */
  automation: "all" | "read";
}): string[] {
  const names = new Set<string>();
  for (const name of PREAPPROVED_TOOL_NAMES) {
    if (opts.chat || !CHAT_TOOL_NAMES.has(name)) names.add(name);
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

/** Pre-approved tools for the interactive in-app agent. */
export function chatPreapprovedToolNames(): string[] {
  return preapprovedToolNames({ chat: true, automation: "all" });
}

/** Pre-approved tools for a headless automation run. */
export function runPreapprovedToolNames(): string[] {
  return preapprovedToolNames({ chat: false, automation: "read" });
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
   * Only specs with an args builder can be launched. The others are listed so
   * the UI can say "found, not wired up yet" instead of pretending they do
   * not exist.
   */
  args?: (ctx: LaunchContext, model?: string) => string[];
  /**
   * Headless one-shot form used by automation runs: the same wiring as `args`
   * with the automation prompt and the run allowlist. Absent means this CLI
   * cannot carry a scheduled run, even when it can carry the chat loop.
   */
  runArgs?: (ctx: LaunchContext, prompt: string, model?: string) => string[];
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
   * and discarded, which is what every CLI did before.
   */
  readEvent?: ReadEvent;
  /**
   * Runs the chat loop in this process for a CLI whose `args` start a server
   * rather than a one-shot session. Called once, straight after spawn; the
   * launcher stops it when the child exits or is stopped. Null means the
   * driver declined (no channel), which leaves the child running untouched.
   */
  drive?: (
    ctx: LaunchContext,
    opts: {
      child: ChildProcess;
      workDir: string;
      model?: string;
      /** The spec's own childEnv entries, as spawned. Secrets ride here. */
      env: Record<string, string>;
    },
  ) => AgentDriver | null;
};

/**
 * Claude Code, headless. --strict-mcp-config keeps the user's other MCP
 * servers out of a process Boxaide is responsible for; the allowlist is the
 * read/draft boundary (send stays un-approved, which headless mode denies).
 */
function claudeArgs(ctx: LaunchContext, model?: string): string[] {
  return [
    ...claudeArgsFor(
      ctx,
      KICKOFF,
      chatPreapprovedToolNames().map((name) => `mcp__boxaide__${name}`),
      model,
    ),
    // NDJSON of the session's own events, which agent-stream.ts reads for
    // presence. --verbose is what makes -p emit the per-event lines rather
    // than only the final result; both flags were verified against the CLI.
    // Chat only: a scheduled run's log is read by a human, so it stays text.
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/**
 * One-shot form: identical wiring, different prompt and allowlist. Same
 * `-p` headless mode — the chat loop only exists because KICKOFF tells the
 * model to loop, so a plain prompt already exits after the work is done.
 */
function claudeRunArgs(
  ctx: LaunchContext,
  prompt: string,
  model?: string,
): string[] {
  return claudeArgsFor(
    ctx,
    prompt,
    runPreapprovedToolNames().map((name) => `mcp__boxaide__${name}`),
    model,
  );
}

function claudeArgsFor(
  ctx: LaunchContext,
  prompt: string,
  allowedTools: string[],
  model?: string,
): string[] {
  return [
    "-p",
    prompt,
    ...(model ? ["--model", model] : []),
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        boxaide: {
          type: "http",
          url: ctx.mcpUrl,
          headers: { Authorization: `Bearer ${ctx.bearerToken}` },
        },
      },
    }),
    "--strict-mcp-config",
    "--allowedTools",
    allowedTools.join(","),
  ];
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
function grokHomeFor(ctx: LaunchContext): string {
  const root =
    ctx.dataDir === ":memory:" ? join(tmpdir(), "boxaide-agent") : ctx.dataDir;
  return join(root, "agent-homes", "grok");
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

function grokChildEnv(ctx: LaunchContext, _workDir: string): Record<string, string> {
  return {
    GROK_HOME: grokHomeFor(ctx),
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
  const home = grokHomeFor(ctx);
  mkdirSync(home, { recursive: true });

  let trusted = workDir;
  try {
    trusted = realpathSync(workDir);
  } catch {
    // The directory was just created; the unresolved path is still the cwd.
  }

  writeFileSync(join(home, "config.toml"), grokConfigToml(ctx), { mode: 0o600 });
  writeFileSync(join(home, "trusted_folders.toml"), grokTrustToml(trusted), {
    mode: 0o600,
  });

  // If GROK_HOME is ignored, project config in the empty workdir still
  // declares boxaide. Same name as the isolated user server, so it does
  // not stack a second copy when both are read.
  const projectGrok = join(workDir, ".grok");
  mkdirSync(projectGrok, { recursive: true });
  writeFileSync(join(projectGrok, "config.toml"), grokProjectToml(ctx), {
    mode: 0o600,
  });

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
  try {
    unlinkSync(to);
  } catch {
    // First launch, or a leftover we can overwrite.
  }
  try {
    symlinkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * `agy models` prints "id<TAB>Label" for everything the account can reach.
 */
const ANTIGRAVITY_LISTER: ModelLister = {
  args: ["models"],
  parse: parseTabbedModels,
};

/**
 * `opencode models` prints bare "provider/model" ids. --pure matches how the
 * launcher runs the CLI, so the list is what a launch would actually accept.
 */
const OPENCODE_LISTER: ModelLister = {
  args: ["--pure", "models"],
  parse: parseBareModels,
};

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
 * Pin a model even when the user picked none. OpenCode's own default
 * retries forever when that endpoint is down, and the pane then waits
 * for a chat_await_message that never comes.
 */
const OPENCODE_DEFAULT_MODEL = "opencode/big-pickle";

/**
 * Antigravity (agy), headless.
 */
function antigravityArgs(_ctx: LaunchContext, model?: string): string[] {
  return [
    "-p",
    KICKOFF,
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    ...(model ? ["--model", model] : []),
  ];
}

function antigravityRunArgs(
  _ctx: LaunchContext,
  prompt: string,
  model?: string,
): string[] {
  return [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    ...(model ? ["--model", model] : []),
  ];
}

function antigravityPrepare(ctx: LaunchContext, workDir: string): void {
  const agentsDir = join(workDir, ".agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
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
    { mode: 0o600 },
  );
}

/**
 * OpenCode, headless.
 *
 * `run` ignores spawn cwd and walks to a git checkout (observed: it left the
 * empty workdir and opened this repo). --dir pins it. Global
 * ~/.config/opencode/opencode.json is merged unless XDG_CONFIG_HOME is
 * elsewhere, and that file on a real machine starts the user's other MCP
 * servers. Auth stays in the default data dir so the process still has keys.
 */
function agentWorkDir(ctx: LaunchContext): string {
  return ctx.dataDir === ":memory:"
    ? join(tmpdir(), "boxaide-agent")
    : join(ctx.dataDir, "agent-workdir");
}

function opencodeHomeFor(ctx: LaunchContext): string {
  const root =
    ctx.dataDir === ":memory:" ? join(tmpdir(), "boxaide-agent") : ctx.dataDir;
  return join(root, "agent-homes", "opencode");
}

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
  opts: { child: ChildProcess; workDir: string; model?: string; env: Record<string, string> },
): AgentDriver | null {
  // Without a channel there is nobody to drive for: the launcher still runs
  // the server, and the MCP tier is unaffected.
  if (!ctx.channel) return null;
  return new OpenCodeDriver({
    channel: ctx.channel,
    agent: "opencode",
    baseUrl: serveBaseUrl(opts.child),
    directory: agentWorkDir(ctx),
    password: opts.env.OPENCODE_SERVER_PASSWORD ?? null,
    model: opts.model ?? OPENCODE_DEFAULT_MODEL,
  }).start();
}

function opencodeRunArgs(
  ctx: LaunchContext,
  prompt: string,
  model?: string,
): string[] {
  return opencodeArgsFor(ctx, prompt, model, { formatJson: false });
}

function opencodeArgsFor(
  ctx: LaunchContext,
  prompt: string,
  model: string | undefined,
  opts: { formatJson: boolean },
): string[] {
  return [
    "--pure",
    "run",
    "--auto",
    "--dir",
    agentWorkDir(ctx),
    ...(opts.formatJson ? ["--format", "json"] : []),
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

function opencodePrepare(ctx: LaunchContext, workDir: string): void {
  mkdirSync(join(opencodeHomeFor(ctx), "config"), { recursive: true });
  writeFileSync(
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
            headers: {
              Authorization: `Bearer ${ctx.bearerToken}`,
            },
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export const KNOWN_AGENTS: AgentSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    args: claudeArgs,
    runArgs: claudeRunArgs,
    models: CLAUDE_MODELS,
    readEvent: readClaudeEvent,
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
    args: antigravityArgs,
    runArgs: antigravityRunArgs,
    listModels: ANTIGRAVITY_LISTER,
    prepare: antigravityPrepare,
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
    readEvent: readOpenCodeEvent,
    drive: opencodeDrive,
  },
  // Detected and shown, not yet launchable: their CLIs have no verified way
  // to take an MCP server plus a per-tool allowlist on one command line.
  { id: "codex", label: "Codex", bin: "codex" },
];

export type ListedAgent = {
  id: string;
  label: string;
  /** The binary exists on PATH. */
  available: boolean;
  /** This build knows how to launch it. */
  supported: boolean;
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

export type LastExit = {
  id: string;
  code: number | null;
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
  /** AgentSpec id, or null/undefined for the first launchable installed CLI. */
  agentId?: string | null;
  /** The automation prompt. The run preamble is prepended here, not by callers. */
  prompt: string;
  /** Overridable for tests only; production runs use ONESHOT_TIMEOUT_MS. */
  timeoutMs?: number;
};

/** Spec: 15-minute hard timeout, then SIGKILL and status 'killed'. */
export const ONESHOT_TIMEOUT_MS = 15 * 60 * 1000;

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
   * The in-flight automation run. Separate from `child`/`running`, which stay
   * the interactive chat agent's state: the Agent pane's presence, the
   * /api/agents status, and stop() must not start reporting on a scheduled run
   * that the user never pressed Start on.
   */
  private oneShot: ChildProcess | null = null;
  /** The in-process loop driving the chat agent, for specs that have one. */
  private driver: AgentDriver | null = null;
  /** Set while a one-shot is alive; closes over that run's kill/status flag. */
  private killOneShot: (() => void) | null = null;
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

  constructor(
    private ctx: LaunchContext,
    private registry: AgentSpec[] = KNOWN_AGENTS,
    private env: NodeJS.ProcessEnv = process.env,
    private extraBinDirs: string[] = wellKnownBinDirs(),
  ) {}

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
          supported: spec.args !== undefined,
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
   * Refuses unless this launcher owns no live process. Called before a launch
   * and again after any await that precedes the spawn — `this.running` is
   * only trustworthy for as long as the call does not yield.
   */
  private assertIdle(): void {
    const running = this.running;
    if (running) {
      throw new LaunchError(409, `${running.id} is already running`);
    }
    if (this.oneShot) {
      throw new LaunchError(409, "an automation run is in progress");
    }
  }

  status(): { running: RunningAgent | null; lastExit: LastExit | null } {
    return { running: this.running, lastExit: this.lastExit };
  }

  /**
   * True while any agent process this launcher owns is alive — chat or
   * automation run. The scheduler asks before dequeuing (spec invariant 4).
   */
  busy(): boolean {
    return this.running !== null || this.oneShot !== null;
  }

  /**
   * Throws with a message fit for the API response.
   *
   * Async because validating the picked model may have to ask the CLI what it
   * offers; that answer is normally already cached by the list() the UI ran to
   * draw the picker.
   */
  async start(id: string, model?: string): Promise<RunningAgent> {
    this.assertIdle();
    const spec = this.registry.find((s) => s.id === id);
    if (!spec) throw new LaunchError(404, `unknown agent: ${id}`);
    if (!spec.args) {
      throw new LaunchError(400, `${spec.label} cannot be launched yet`);
    }
    const bin = this.resolveBin(spec.bin);
    if (!bin) {
      throw new LaunchError(400, `${spec.label} is not installed (no ${spec.bin} on PATH)`);
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
      // orphaned by the second overwriting this.child.
      this.assertIdle();
    }

    const workDir = this.prepareWorkDir(spec);

    this.stderrTail = "";
    // Built once and shared with the driver: a spec's childEnv may mint a
    // per-launch secret, and the driver must see the exact value the child got.
    const childEnv = spec.childEnv?.(this.ctx, workDir) ?? {};
    const child = spawn(bin, spec.args(this.ctx, model), {
      cwd: workDir,
      env: this.baseEnvWith(childEnv),
      // stdout is piped for the event stream, and MUST be consumed: a pipe
      // nobody reads fills its buffer and blocks the agent mid-write. The
      // handler below reads every chunk whether or not anything wants it.
      stdio: ["ignore", "pipe", "pipe"],
    });
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

    const started: RunningAgent = {
      id: spec.id,
      pid: child.pid ?? -1,
      startedAt: new Date().toISOString(),
      model: model ?? null,
    };
    child.on("error", (err) => {
      // Spawn failures (ENOENT, EACCES) surface as an exit, not an exception.
      this.stderrTail = `${this.stderrTail}\n${err.message}`.trim();
      this.noteExit(spec.id, null);
    });
    // "close", not "exit": exit fires while stderr may still hold undrained
    // data (observed on Linux), and the tail is the whole point of capturing.
    child.on("close", (code) => this.noteExit(spec.id, code));

    this.child = child;
    this.running = started;
    // Before the driver: the channel has to know a launched agent exists, or
    // the loop's first awaitUserTurn is stamped against nobody.
    this.ctx.onRunningChange?.(spec.id);
    this.driver = spec.drive?.(this.ctx, { child, workDir, model, env: childEnv }) ?? null;
    return started;
  }

  /**
   * One headless run of an automation prompt, resolved when the CLI exits.
   *
   * Everything except the prompt, the allowlist and the output capture is the
   * chat path: same binary resolution, same MCP config, same widened PATH,
   * same isolated workdir and per-CLI prepare step.
   *
   * Refuses while any agent is alive rather than queueing internally — the
   * scheduler owns the queue and its FIFO order, and a launcher that blocked
   * here would hold a run row open for an unbounded chat session.
   */
  async runOnce(opts: OneShotOptions): Promise<OneShotResult> {
    if (this.running) {
      throw new LaunchError(409, `${this.running.id} is already running`);
    }
    if (this.oneShot) {
      throw new LaunchError(409, "an automation run is in progress");
    }
    const spec = this.resolveRunSpec(opts.agentId);
    const bin = this.resolveBin(spec.bin);
    if (!bin) {
      throw new LaunchError(
        400,
        `${spec.label} is not installed (no ${spec.bin} on PATH)`,
      );
    }
    const workDir = this.prepareWorkDir(spec);
    const prompt = `${AUTOMATION_RUN_PREAMBLE}\n\n${opts.prompt}`;

    const child = spawn(bin, spec.runArgs!(this.ctx, prompt), {
      cwd: workDir,
      env: this.childEnvFor(spec, workDir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.oneShot = child;

    let log = "";
    const capture = (chunk: string) => {
      log = (log + chunk).slice(-ONESHOT_LOG_LIMIT);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", capture);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", capture);

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      // SIGKILL, not SIGTERM: the deadline has already passed, and a CLI that
      // ignores a polite signal would hold the single run slot indefinitely.
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? ONESHOT_TIMEOUT_MS);
    timer.unref?.();
    this.killOneShot = () => {
      killed = true;
      child.kill("SIGKILL");
    };

    return await new Promise<OneShotResult>((resolve) => {
      const finish = (code: number | null) => {
        clearTimeout(timer);
        this.oneShot = null;
        this.killOneShot = null;
        resolve({
          status: killed ? "killed" : code === 0 ? "ok" : "error",
          exitCode: code,
          log,
        });
      };
      child.on("error", (err) => {
        // Spawn failures (ENOENT, EACCES) never reach "close" with a code.
        capture(`\n${err.message}`);
        finish(null);
      });
      // "close", not "exit": exit can fire while stdout/stderr still hold
      // undrained data, and the log is the whole point of capturing.
      child.on("close", (code) => finish(code));
    });
  }

  /** Kills an in-flight automation run. No-op when none is running. */
  killRun(): void {
    this.killOneShot?.();
  }

  /** Idempotent: stopping with nothing running is a no-op. */
  stop(): void {
    this.child?.kill("SIGTERM");
    // State clears in the exit handler, so status() keeps saying "running"
    // only while the process actually exists.
  }

  close(): void {
    const had = this.running !== null;
    // The loop first: it parks on the channel, and a wait left open would hold
    // the process past shutdown.
    this.driver?.stop();
    this.driver = null;
    this.child?.kill("SIGTERM");
    this.child = null;
    this.running = null;
    this.killRun();
    if (had) this.ctx.onRunningChange?.(null);
  }

  /**
   * An empty, dedicated working directory: no repository context, no
   * CLAUDE.md, nothing for the agent to read into the session by accident.
   * Shared by the chat agent and automation runs — they never overlap.
   * OpenCode is also passed this path as --dir; spawn cwd is not enough.
   */
  private prepareWorkDir(spec: AgentSpec): string {
    const workDir = agentWorkDir(this.ctx);
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

  private noteExit(id: string, code: number | null): void {
    if (this.running?.id !== id) return;
    // The server is gone, so the loop has nothing to prompt.
    this.driver?.stop();
    this.driver = null;
    this.lastExit = {
      id,
      code,
      at: new Date().toISOString(),
      stderrTail: this.stderrTail,
    };
    this.running = null;
    this.child = null;
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

/**
 * Local agent launcher: Sley starts the agent, instead of waiting for one.
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
 *  - Read and draft tools are pre-approved. `message_send` is NOT in the
 *    allowlist, so a launched agent that tries to send hits the client's own
 *    permission wall, which in headless mode is a denial.
 *  - One agent at a time. The channel hands each user message to exactly one
 *    waiter; a second launched agent would race it for every message.
 */
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
import { CRM_TOOL_NAMES } from "../crm/tools.js";
import { AUTOMATION_TOOL_NAMES } from "../automation/tools.js";
import { OUTREACH_TOOL_NAMES } from "../outreach/tools.js";

/**
 * Where agent CLIs actually live, beyond PATH.
 *
 * A macOS app launched from Finder inherits launchd's PATH —
 * /usr/bin:/bin:/usr/sbin:/sbin — not the login shell's. Every agent CLI on a
 * real machine lives outside that (Homebrew, ~/.local/bin, per-tool bins), so
 * detection that only reads PATH finds nothing exactly when Sley runs as
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
const KICKOFF = `You are my Sley inbox agent. Use the Sley MCP tools.

Loop: call chat_await_message, do the work, post the answer with chat_say, then
call chat_await_message again. Keep going until I tell you to stop.

Everything I read appears in the Sley window, so every answer must go through
chat_say — do not answer here. A chat_await_message that returns no message is
normal; call it again. Use chat_activity for anything slow. Draft rather than
send unless I ask you to send.`;

/**
 * Every Sley tool except message_send. Deliberately a hand-written
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

const CLAUDE_PREAPPROVED_TOOLS = PREAPPROVED_TOOL_NAMES.map(
  (name) => `mcp__sley__${name}`,
);

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
  "You are a scheduled mailmux automation. Do the task below using the mailmux MCP tools, then exit. You cannot talk to the user: do not call chat tools; write nothing to the user. Never send email: queue outreach with outbox_queue_draft or save with draft_create and a human will review.";

/** Automation tools a run may call: reads only. It must not edit the schedule. */
const RUN_AUTOMATION_READ_TOOLS = ["automations_list", "automation_runs_list"];

/**
 * Pre-approved tools for a headless automation run.
 *
 * Computed per call rather than frozen at import: the module-level tool sets
 * come from three other modules, and a function keeps this honest about the
 * lists as they actually are at spawn time. The chat tools drop out (no user
 * on the other end) and message_send is deleted last, unconditionally — the
 * one rule that survives any future addition to those sets.
 */
export function runPreapprovedToolNames(): string[] {
  const names = new Set<string>();
  for (const name of PREAPPROVED_TOOL_NAMES) {
    if (!CHAT_TOOL_NAMES.has(name)) names.add(name);
  }
  for (const name of CRM_TOOL_NAMES) names.add(name);
  for (const name of RUN_AUTOMATION_READ_TOOLS) {
    if (AUTOMATION_TOOL_NAMES.has(name)) names.add(name);
  }
  for (const name of OUTREACH_TOOL_NAMES) names.add(name);
  names.delete("message_send");
  return [...names];
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
};

/**
 * A model the user may pick for an agent. The id is what reaches the CLI's
 * command line, so ids exist only in this file — a request can select one,
 * never define one.
 */
export type ModelOption = { id: string; label: string };

export type AgentSpec = {
  id: string;
  label: string;
  /** Binary name looked up on PATH. */
  bin: string;
  /**
   * Models this CLI accepts via a flag we have verified. Absent means the
   * CLI always runs on its own default and the UI shows no picker.
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
};

/**
 * Claude Code, headless. --strict-mcp-config keeps the user's other MCP
 * servers out of a process Sley is responsible for; the allowlist is the
 * read/draft boundary (send stays un-approved, which headless mode denies).
 */
function claudeArgs(ctx: LaunchContext, model?: string): string[] {
  return claudeArgsFor(ctx, KICKOFF, CLAUDE_PREAPPROVED_TOOLS, model);
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
    runPreapprovedToolNames().map((name) => `mcp__mailmux__${name}`),
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
        sley: {
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
 * the user's ~/.grok servers and plugins are not loaded, write sley as
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
    ctx.dataDir === ":memory:" ? join(tmpdir(), "sley-agent") : ctx.dataDir;
  return join(root, "agent-homes", "grok");
}

function grokArgs(_ctx: LaunchContext): string[] {
  return grokArgsFor(KICKOFF, PREAPPROVED_TOOL_NAMES);
}

function grokRunArgs(_ctx: LaunchContext, prompt: string): string[] {
  return grokArgsFor(prompt, runPreapprovedToolNames());
}

function grokArgsFor(prompt: string, allowed: readonly string[]): string[] {
  const args = [
    "-p",
    prompt,
    "--verbatim",
    "--permission-mode",
    "dontAsk",
    "--no-subagents",
    "--no-plan",
    "--no-memory",
    "--disable-web-search",
  ];
  for (const name of allowed) {
    args.push("--allow", `MCPTool(sley__${name})`);
  }
  return args;
}

function grokChildEnv(ctx: LaunchContext, _workDir: string): Record<string, string> {
  return {
    GROK_HOME: grokHomeFor(ctx),
    SLEY_TOKEN: ctx.bearerToken,
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
  // declares sley. Same name as the isolated user server, so it does
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
    "[mcp_servers.sley]",
    `url = ${tomlString(ctx.mcpUrl)}`,
    `bearer_token_env_var = ${tomlString("SLEY_TOKEN")}`,
    "",
  ].join("\n");
}

function grokProjectToml(ctx: LaunchContext): string {
  return [
    "[mcp_servers.sley]",
    `url = ${tomlString(ctx.mcpUrl)}`,
    `bearer_token_env_var = ${tomlString("SLEY_TOKEN")}`,
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
 * Models the `claude` CLI's --model flag accepts. Aliases ("sonnet") float
 * with CLI updates; full ids pin the choice the user actually made.
 */
const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

export const KNOWN_AGENTS: AgentSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    args: claudeArgs,
    runArgs: claudeRunArgs,
    models: CLAUDE_MODELS,
  },
  {
    id: "grok",
    label: "Grok",
    bin: "grok",
    args: grokArgs,
    runArgs: grokRunArgs,
    childEnv: grokChildEnv,
    prepare: grokPrepare,
  },
  // Detected and shown, not yet launchable: their CLIs have no verified way
  // to take an MCP server plus a per-tool allowlist on one command line.
  { id: "codex", label: "Codex", bin: "codex" },
  { id: "gemini", label: "Gemini CLI", bin: "gemini" },
  { id: "opencode", label: "opencode", bin: "opencode" },
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
  /** Set while a one-shot is alive; closes over that run's kill/status flag. */
  private killOneShot: (() => void) | null = null;

  constructor(
    private ctx: LaunchContext,
    private registry: AgentSpec[] = KNOWN_AGENTS,
    private env: NodeJS.ProcessEnv = process.env,
    private extraBinDirs: string[] = wellKnownBinDirs(),
  ) {}

  list(): ListedAgent[] {
    return this.registry.map((spec) => ({
      id: spec.id,
      label: spec.label,
      available: this.resolveBin(spec.bin) !== null,
      supported: spec.args !== undefined,
      models: spec.models ?? [],
    }));
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

  /** Throws with a message fit for the API response. */
  start(id: string, model?: string): RunningAgent {
    if (this.running) {
      throw new LaunchError(409, `${this.running.id} is already running`);
    }
    if (this.oneShot) {
      throw new LaunchError(409, "an automation run is in progress");
    }
    const spec = this.registry.find((s) => s.id === id);
    if (!spec) throw new LaunchError(404, `unknown agent: ${id}`);
    if (!spec.args) {
      throw new LaunchError(400, `${spec.label} cannot be launched yet`);
    }
    // The model id becomes an argv element, so only ids from this file's
    // registry pass — the same rule that protects the agent id itself.
    if (model !== undefined && !spec.models?.some((m) => m.id === model)) {
      throw new LaunchError(400, `${spec.label} does not offer that model`);
    }
    const bin = this.resolveBin(spec.bin);
    if (!bin) {
      throw new LaunchError(400, `${spec.label} is not installed (no ${spec.bin} on PATH)`);
    }

    const workDir = this.prepareWorkDir(spec);

    this.stderrTail = "";
    const child = spawn(bin, spec.args(this.ctx, model), {
      cwd: workDir,
      env: this.childEnvFor(spec, workDir),
      stdio: ["ignore", "ignore", "pipe"],
    });
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
    this.ctx.onRunningChange?.(spec.id);
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
   */
  private prepareWorkDir(spec: AgentSpec): string {
    const workDir =
      this.ctx.dataDir === ":memory:"
        ? join(tmpdir(), "sley-agent")
        : join(this.ctx.dataDir, "agent-workdir");
    mkdirSync(workDir, { recursive: true });
    spec.prepare?.(this.ctx, workDir, this.env);
    return workDir;
  }

  private childEnvFor(spec: AgentSpec, workDir: string): NodeJS.ProcessEnv {
    return {
      ...this.env,
      // The widened PATH travels with the agent: launched from the Finder app
      // the inherited PATH lacks even the directory its own binary sits in.
      PATH: this.searchDirs().join(delimiter),
      ...spec.childEnv?.(this.ctx, workDir),
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
    const names =
      process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
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

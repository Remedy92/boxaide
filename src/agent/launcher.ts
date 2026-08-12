/**
 * Local agent launcher: mailmux starts the agent, instead of waiting for one.
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

/**
 * Where agent CLIs actually live, beyond PATH.
 *
 * A macOS app launched from Finder inherits launchd's PATH —
 * /usr/bin:/bin:/usr/sbin:/sbin — not the login shell's. Every agent CLI on a
 * real machine lives outside that (Homebrew, ~/.local/bin, per-tool bins), so
 * detection that only reads PATH finds nothing exactly when mailmux runs as
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
const KICKOFF = `You are my mailmux inbox agent. Use the mailmux MCP tools.

Loop: call chat_await_message, do the work, post the answer with chat_say, then
call chat_await_message again. Keep going until I tell you to stop.

Everything I read appears in the mailmux window, so every answer must go through
chat_say — do not answer here. A chat_await_message that returns no message is
normal; call it again. Use chat_activity for anything slow. Draft rather than
send unless I ask you to send.`;

/**
 * Every mailmux tool except message_send. Deliberately a hand-written
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
  (name) => `mcp__mailmux__${name}`,
);

export type LaunchContext = {
  mcpUrl: string;
  bearerToken: string;
  /** Where the agent's empty working directory is created. */
  dataDir: string;
};

export type AgentSpec = {
  id: string;
  label: string;
  /** Binary name looked up on PATH. */
  bin: string;
  /**
   * Only specs with an args builder can be launched. The others are listed so
   * the UI can say "found, not wired up yet" instead of pretending they do
   * not exist.
   */
  args?: (ctx: LaunchContext) => string[];
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
 * servers out of a process mailmux is responsible for; the allowlist is the
 * read/draft boundary (send stays un-approved, which headless mode denies).
 */
function claudeArgs(ctx: LaunchContext): string[] {
  return [
    "-p",
    KICKOFF,
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        mailmux: {
          type: "http",
          url: ctx.mcpUrl,
          headers: { Authorization: `Bearer ${ctx.bearerToken}` },
        },
      },
    }),
    "--strict-mcp-config",
    "--allowedTools",
    CLAUDE_PREAPPROVED_TOOLS.join(","),
  ];
}

/**
 * Grok Build, headless. There is no --mcp-config / --strict-mcp-config: MCP
 * servers come from config.toml. We give the process its own GROK_HOME so
 * the user's ~/.grok servers and plugins are not loaded, write mailmux as
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
    ctx.dataDir === ":memory:" ? join(tmpdir(), "mailmux-agent") : ctx.dataDir;
  return join(root, "agent-homes", "grok");
}

function grokArgs(_ctx: LaunchContext): string[] {
  const args = [
    "-p",
    KICKOFF,
    "--verbatim",
    "--permission-mode",
    "dontAsk",
    "--no-subagents",
    "--no-plan",
    "--no-memory",
    "--disable-web-search",
  ];
  for (const name of PREAPPROVED_TOOL_NAMES) {
    args.push("--allow", `MCPTool(mailmux__${name})`);
  }
  return args;
}

function grokChildEnv(ctx: LaunchContext, _workDir: string): Record<string, string> {
  return {
    GROK_HOME: grokHomeFor(ctx),
    MAILMUX_TOKEN: ctx.bearerToken,
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
  // declares mailmux. Same name as the isolated user server, so it does
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
    "[mcp_servers.mailmux]",
    `url = ${tomlString(ctx.mcpUrl)}`,
    `bearer_token_env_var = ${tomlString("MAILMUX_TOKEN")}`,
    "",
  ].join("\n");
}

function grokProjectToml(ctx: LaunchContext): string {
  return [
    "[mcp_servers.mailmux]",
    `url = ${tomlString(ctx.mcpUrl)}`,
    `bearer_token_env_var = ${tomlString("MAILMUX_TOKEN")}`,
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

export const KNOWN_AGENTS: AgentSpec[] = [
  { id: "claude-code", label: "Claude Code", bin: "claude", args: claudeArgs },
  {
    id: "grok",
    label: "Grok",
    bin: "grok",
    args: grokArgs,
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
};

export type RunningAgent = { id: string; pid: number; startedAt: string };

export type LastExit = {
  id: string;
  code: number | null;
  at: string;
  /** Last few KB of stderr, for the UI to explain a crash. */
  stderrTail: string;
};

const STDERR_TAIL_LIMIT = 4_096;

export class AgentLauncher {
  private child: ChildProcess | null = null;
  private running: RunningAgent | null = null;
  private lastExit: LastExit | null = null;
  private stderrTail = "";

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
    }));
  }

  status(): { running: RunningAgent | null; lastExit: LastExit | null } {
    return { running: this.running, lastExit: this.lastExit };
  }

  /** Throws with a message fit for the API response. */
  start(id: string): RunningAgent {
    if (this.running) {
      throw new LaunchError(409, `${this.running.id} is already running`);
    }
    const spec = this.registry.find((s) => s.id === id);
    if (!spec) throw new LaunchError(404, `unknown agent: ${id}`);
    if (!spec.args) {
      throw new LaunchError(400, `${spec.label} cannot be launched yet`);
    }
    const bin = this.resolveBin(spec.bin);
    if (!bin) {
      throw new LaunchError(400, `${spec.label} is not installed (no ${spec.bin} on PATH)`);
    }

    // An empty, dedicated working directory: no repository context, no
    // CLAUDE.md, nothing for the agent to read into the session by accident.
    const workDir =
      this.ctx.dataDir === ":memory:"
        ? join(tmpdir(), "mailmux-agent")
        : join(this.ctx.dataDir, "agent-workdir");
    mkdirSync(workDir, { recursive: true });
    spec.prepare?.(this.ctx, workDir, this.env);

    this.stderrTail = "";
    const child = spawn(bin, spec.args(this.ctx), {
      cwd: workDir,
      // The widened PATH travels with the agent: launched from the Finder app
      // the inherited PATH lacks even the directory its own binary sits in.
      env: {
        ...this.env,
        PATH: this.searchDirs().join(delimiter),
        ...spec.childEnv?.(this.ctx, workDir),
      },
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
    return started;
  }

  /** Idempotent: stopping with nothing running is a no-op. */
  stop(): void {
    this.child?.kill("SIGTERM");
    // State clears in the exit handler, so status() keeps saying "running"
    // only while the process actually exists.
  }

  close(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.running = null;
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

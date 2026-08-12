/**
 * Local agent launcher: mailmux starts the agent, instead of waiting for one.
 *
 * MCP is client-driven, so the Agent view is silent until some client enters
 * the chat_await_message loop. For GUI clients (Claude Desktop) nothing can
 * automate that. For CLI agents there is no such wall: `claude -p` runs
 * headless, takes its MCP servers on the command line, and keeps looping for
 * as long as the kickoff prompt tells it to. This module detects which known
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
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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
 * Every mailmux tool except message_send, in Claude Code's MCP tool
 * namespace. Deliberately a hand-written allowlist and not "TOOLS minus
 * send": adding a new server tool must not silently pre-approve it here.
 */
const PREAPPROVED_TOOLS = [
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
].map((name) => `mcp__mailmux__${name}`);

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
    PREAPPROVED_TOOLS.join(","),
  ];
}

export const KNOWN_AGENTS: AgentSpec[] = [
  { id: "claude-code", label: "Claude Code", bin: "claude", args: claudeArgs },
  // Detected and shown, not yet launchable: their CLIs have no verified way
  // to take an MCP server plus a per-tool allowlist on one command line.
  { id: "codex", label: "Codex", bin: "codex" },
  { id: "gemini", label: "Gemini CLI", bin: "gemini" },
  { id: "grok", label: "Grok", bin: "grok" },
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

    this.stderrTail = "";
    const child = spawn(bin, spec.args(this.ctx), {
      cwd: workDir,
      env: { ...this.env },
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
    child.on("exit", (code) => this.noteExit(spec.id, code));

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

  private resolveBin(bin: string): string | null {
    const dirs = (this.env.PATH ?? "").split(delimiter).filter(Boolean);
    const names =
      process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
    for (const dir of dirs) {
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

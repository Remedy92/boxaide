/** OpenCode: the served chat launch its driver prompts, and the one-shot run. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readOpenCodeEvent } from "../agent-stream.js";
import type { AgentDriver } from "../driver.js";
import { chatMemoryBlock } from "../memory-context.js";
import { parseBareModels, type ModelLister } from "../model-list.js";
import { OpenCodeDriver, serveBaseUrl } from "../opencode-driver.js";
import { agentRoot } from "../paths.js";
import {
  writeSecret,
  type AgentSpec,
  type DriveOptions,
  type LaunchContext,
} from "../spec.js";

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
 * opinion. It stays up and the driver holds the loop (see opencode-driver.ts).
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
 * and a denied mkdir there is fatal. Verified: a confined `opencode --version`
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

const OPENCODE_ISOLATION = () => ({
  isolated: true,
  note: "Runs under XDG directories Boxaide owns, so your own config does not load.",
});

export const OPENCODE_SPEC: AgentSpec = {
  id: "opencode",
  label: "OpenCode",
  bin: "opencode",
  args: opencodeArgs,
  runArgs: opencodeRunArgs,
  listModels: OPENCODE_LISTER,
  childEnv: opencodeChildEnv,
  prepare: opencodePrepare,
  sandbox: opencodeSandbox,
  isolation: OPENCODE_ISOLATION,
  readEvent: readOpenCodeEvent,
  drive: opencodeDrive,
};

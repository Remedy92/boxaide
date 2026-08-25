/**
 * Antigravity (agy): the driven spec, argv for one turn, the workspace MCP
 * config it reads, and the two guards around the user's own global MCP config.
 *
 * The chat loop is Boxaide's, not the model's, see agy-driver.ts for why the
 * `agy -p KICKOFF` launch this replaces could not stay up.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAgyAuthFailure } from "../agent-stream.js";
import { AgyDriver, agyPrintTimeoutArg } from "../agy-driver.js";
import type { AgentDriver } from "../driver.js";
import { chatMemoryBlock } from "../memory-context.js";
import { parseTabbedModels, type ModelLister } from "../model-list.js";
import { agentWorkDir } from "../paths.js";
import type { TurnRequest } from "../turn-driver.js";
import {
  writeSecret,
  type AgentSpec,
  type DriveOptions,
  type LaunchContext,
} from "../spec.js";

/**
 * One driven turn of Antigravity, as a command line.
 *
 * agy has no server mode and no `--append-system-prompt`, so a turn is a
 * process and the framing rides at the head of the prompt. `--conversation`
 * carries the id the last turn reported. Exported for the driver and for tests;
 * the launcher is the only place that decides what flags Boxaide passes to a
 * CLI.
 *
 * agy has no --allowedTools and no --mcp-config, which is exactly why it was
 * listed as "not launchable" before the server learned scopes: the only way to
 * run it unattended is --dangerously-skip-permissions, and that used to mean
 * handing the master bearer to a process that would approve anything asked of
 * it. The scoped token is what makes that flag safe. "skip permissions" now
 * means "skip asking about tools the server has already decided this launch
 * may call", and the ones it may not are refused whatever the CLI approves.
 * The driven scope is narrower still: the loop's own chat tools are not in it.
 */
export function antigravityTurnArgs(
  ctx: LaunchContext,
  turn: TurnRequest,
  model?: string,
): string[] {
  return [
    "-p",
    antigravityPrompt(turn),
    // Without this agy does not read the .agents/ directory it is standing in,
    // and Boxaide's server is simply absent from the session. Verified
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
    // Left to its default this is 5 minutes, which is what killed the launch
    // this replaces. Named here so the number a turn is held to is one this
    // repo chose. See AGY_PRINT_TIMEOUT_MS.
    "--print-timeout",
    agyPrintTimeoutArg(),
    ...(model ? ["--model", model] : []),
    ...(turn.sessionId ? ["--conversation", turn.sessionId] : []),
  ];
}

/**
 * The framing and the message, as one prompt.
 *
 * agy takes no system prompt on a print-mode run, so this is the only way to
 * tell the model what it is answering. The framing goes first, which also means
 * the prompt can never begin with a dash, a user message that did would
 * otherwise be at the mercy of how agy's parser reads a flag value.
 */
function antigravityPrompt(turn: TurnRequest): string {
  return `${turn.system}\n\n---\n\n${turn.prompt}`;
}

function antigravityDrive(
  ctx: LaunchContext,
  opts: DriveOptions,
): AgentDriver | null {
  // Without a channel there is nobody to drive for. `start` refuses this launch
  // before it gets here, since an Antigravity launch is nothing but its driver.
  if (!ctx.channel) return null;
  return new AgyDriver({
    channel: ctx.channel,
    agent: "antigravity",
    // Read per turn, not once here: the agent writes its notes during a
    // session, and a block frozen at launch would keep saying there are none.
    memorySystem: () => chatMemoryBlock(ctx.dataDir),
    // The launch's command, not the bare binary: there is no long-lived child,
    // so these per-turn spawns are the whole agent. Spawning `opts.bin` here
    // would leave every turn outside the sandbox the launch asked for.
    bin: opts.command.bin,
    cwd: opts.workDir,
    env: opts.env,
    argsFor: (turn) => [
      ...opts.command.prefix,
      ...antigravityTurnArgs(ctx, turn, opts.model),
    ],
    onStop: opts.onStop,
  }).start();
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
 * "boxaide", and agy merges every non-colliding server rather than replacing
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
 * workspace, and on a name collision the user's file wins. Verified: a
 * launch whose workspace declared `boxaide` reached the server named in the
 * user's file instead, with the credential written there. Entries that do not
 * collide are merged in rather than replaced, so a user entry under any other
 * name is a second, unscoped connection to the same server.
 *
 * Boxaide's own connect dialog tells users to paste exactly such an entry, and
 * it carries the master bearer. So on a machine that followed those
 * instructions, a launched agy would hold the unscoped credential no matter
 * what this launcher mints. That is the one case where the scope could be
 * bypassed.
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
  const { path, servers } = antigravityUserMcpServers(env);
  if (!servers) return null;
  const found = Object.entries(servers).find(([name, entry]) =>
    reachesBoxaide(name, entry, ctx.mcpUrl),
  );
  if (!found) return null;
  return `Antigravity is configured with its own Boxaide server in ${path}, under the name "${found[0]}". The agent would reach Boxaide through that entry, on the credential written there, instead of the limited one Boxaide issues for a launch. Remove the "${found[0]}" entry from that file and start again; Boxaide wires the connection itself now, so nothing else is needed.`;
}

/**
 * The user's own agy MCP config. The preflight reads it, the run deny names
 * it, and the isolation note describes it, so all three say the same file.
 */
function antigravityUserMcpConfigPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME || homedir(), ".gemini", "config", "mcp_config.json");
}

function antigravityUserMcpServers(env: NodeJS.ProcessEnv): {
  path: string;
  servers: Record<string, unknown> | null;
} {
  const path = antigravityUserMcpConfigPath(env);
  let declared: unknown;
  try {
    declared = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { path, servers: null };
  }
  const servers = (declared as { mcpServers?: Record<string, unknown> })?.mcpServers;
  return {
    path,
    servers: servers && typeof servers === "object" ? servers : null,
  };
}

/** `agy models` prints "id<TAB>Label" for everything the account can reach. */
const ANTIGRAVITY_LISTER: ModelLister = {
  args: ["models"],
  parse: parseTabbedModels,
};

/**
 * agy is the one CLI whose isolation is a sandbox rule, so it is the one that
 * can be lost. With no sandbox the run really does load the user's servers,
 * and the note says so rather than claiming a boundary that is not there.
 */
function antigravityIsolation(
  _env: NodeJS.ProcessEnv,
  confined: boolean,
): { isolated: boolean; note: string } {
  return confined
    ? {
        isolated: true,
        note: "A run cannot read ~/.gemini/config/mcp_config.json, so agy loads only the Boxaide server in the run's own .agents/mcp_config.json. A watched chat launch still loads your global servers.",
      }
    : {
        isolated: false,
        note: "A run is not sandboxed here, so agy loads your global MCP servers from ~/.gemini/config/mcp_config.json. The run is still allowed.",
      };
}

/**
 * agy keeps its sign-in under `~/.gemini`, and unlike the others that home
 * cannot be moved, which is the same reason `antigravityPreflight` exists.
 *
 * Writable, and this is the CLI that proved why. Confined with `~/.gemini`
 * readable but not writable, agy starts, tries to establish its session, has
 * nowhere to put the result, waits, and exits, with no error the user ever
 * sees. The agent simply never picked the message up. Every CLI here signs in
 * by writing something down; none of them can do it read-only.
 *
 * A run also denies one file inside that home: the user's own MCP config. agy
 * merges it into every session and has no strict-config flag, so the
 * operating system is the only thing that can take it away. Verified against
 * agy: under this deny a print-mode run still answers, still holds its
 * sign-in, and still starts the server declared in the run's own
 * `.agents/mcp_config.json`. The deny is written after the write allowance
 * above and wins, because the last matching rule is the one that applies.
 *
 * Chat keeps the file. A watched launch may want the user's own servers, and
 * someone is there to see what they do.
 */
function antigravitySandbox(
  _ctx: LaunchContext,
  _workDir: string,
  env: NodeJS.ProcessEnv,
  kind: "chat" | "run",
): { write: string[]; deny?: string[] } {
  const home = join(env.HOME || homedir(), ".gemini");
  return kind === "run"
    ? { write: [home], deny: [antigravityUserMcpConfigPath(env)] }
    : { write: [home] };
}

export async function probeAntigravityAuth(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<
  | { ok: true }
  | { ok: false; authRequired: boolean; reason: string }
> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (
      result:
        | { ok: true }
        | { ok: false; authRequired: boolean; reason: string },
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {}
      resolve(result);
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        authRequired: isAgyAuthFailure(output),
        reason: isAgyAuthFailure(output)
          ? "Antigravity needs sign-in"
          : "Antigravity readiness check timed out",
      });
    }, timeoutMs);
    timer.unref?.();

    let output = "";
    try {
      child = spawn(bin, ["models"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({
        ok: false,
        authRequired: false,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const onData = (chunk: string) => {
      output = (output + chunk).slice(-8_192);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) =>
      finish({ ok: false, authRequired: false, reason: err.message }),
    );
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true });
      const authRequired = isAgyAuthFailure(output);
      finish({
        ok: false,
        authRequired,
        reason: authRequired
          ? "Antigravity needs sign-in"
          : "Antigravity could not verify its readiness",
      });
    });
  });
}

export function antigravityWarmAuth(
  _ctx: LaunchContext,
  bin: string,
  env: NodeJS.ProcessEnv,
) {
  return probeAntigravityAuth(bin, env);
}

export const ANTIGRAVITY_SPEC: AgentSpec = {
  // No `args`: there is nothing to keep running. The driver spawns one
  // `agy -p` per user turn and resumes the conversation across them, so the
  // chat cannot end because a model decided it was done, or because agy's own
  // print timeout ran out while the model waited for the user to type.
  id: "antigravity",
  label: "Antigravity",
  bin: "agy",
  runArgs: antigravityRunArgs,
  warmAuth: antigravityWarmAuth,
  drive: antigravityDrive,
  listModels: ANTIGRAVITY_LISTER,
  prepare: antigravityPrepare,
  sandbox: antigravitySandbox,
  isolation: antigravityIsolation,
  preflight: antigravityPreflight,
};

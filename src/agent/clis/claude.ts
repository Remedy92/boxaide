/**
 * Claude Code: the driven spec, its isolated config home, and the credential
 * handling that keeps that home signed in.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderClaudeRunLine } from "../agent-stream.js";
import { ClaudeDriver, type ClaudeTurnRequest } from "../claude-driver.js";
import type { AgentDriver } from "../driver.js";
import { chatMemoryBlock } from "../memory-context.js";
import type { ModelOption } from "../model-list.js";
import { agentRoot, agentWorkDir } from "../paths.js";
import {
  copySecret,
  drivenPreapprovedToolNames,
  nativeWebAllowed,
  runPreapprovedToolNames,
  writeSecret,
  type AgentSpec,
  type DriveOptions,
  type LaunchContext,
} from "../spec.js";


/**
 * Claude Code's own web tools, by the names its `--allowedTools` expects.
 * Verified against claude 2.1.233. WebFetch is deliberately withheld: it is a
 * raw fetch with none of the address checks src/research/safe-url.ts applies
 * to boxaide's own web_fetch, so granting it would let a hostile URL in mail
 * reach loopback or link-local services. Search results alone are enough for
 * the unconfigured fallback.
 */
const CLAUDE_NATIVE_WEB_TOOLS = ["WebSearch"];

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
 * `renderRunLine` turns the stream back into text a person reads. Plain `-p`
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
 * out of ~/.claude (hooks, skills, output styles, subagents, settings) still
 * loads, and a scheduled run was observed picking up the user's personal set:
 * a run Boxaide is responsible for must not be reshaped by files the user
 * wrote for their own terminal. CLAUDE_CONFIG_DIR moves all of it to a
 * directory this launcher owns. Deliberately applied to the chat path too,
 * because the isolation is about whose config runs, not which path.
 *
 * Shared across overlapping runs, unlike Grok's home, because this one
 * accumulates state the CLI itself owns: onboarding, project records, refreshed
 * credentials. Handing every run an empty home would make each one a first run.
 * `claude` already supports several sessions against one config directory; what
 * it cannot survive is a half-written file, so every write here is staged and
 * renamed (writeSecret / copySecret).
 */
export function claudeConfigHomeFor(ctx: LaunchContext): string {
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
 * Reads OAuth credentials stored in macOS Keychain by Claude Code.
 */
export function claudeReadKeychainCredentials(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
    if (parsed?.claudeAiOauth?.accessToken) {
      return JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth }, null, 2);
    }
  } catch {
    // No keychain item, security tool failed, or malformed JSON
  }
  return null;
}

function claudeCredentialsExpired(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      claudeAiOauth?: { expiresAt?: number };
    };
    if (parsed?.claudeAiOauth?.expiresAt && parsed.claudeAiOauth.expiresAt < Date.now()) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Auth is the one thing the isolated home must inherit.
 *
 * Copied per launch rather than symlinked: `claude` rewrites this file when it
 * refreshes a token, and through a symlink that write lands in the user's own
 * ~/.claude/.credentials.json, and a process Boxaide is responsible for must not
 * edit the user's terminal auth. prepare runs before every spawn, so the copy
 * is at most one run stale. On macOS the credentials live in the keychain;
 * we read the active token from Keychain and sync it into the isolated home.
 *
 * Never over a login the home owns. Once `claude /login` has run inside the
 * isolated home, that home's credential (keychain entry or file) is the real
 * one, and seeding a copy of the user's terminal file on top of it would
 * shadow a working login with a possibly-stale leftover: the exact failure
 * the heal below exists to undo.
 */
export function claudeCopyCredentials(parentHome: string, home: string): void {
  if (claudeHomeOwnsLogin(home)) return;
  const parent = join(parentHome, ".credentials.json");
  const dest = join(home, ".credentials.json");
  if (existsSync(parent)) {
    try {
      copySecret(parent, dest);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    }
  }
  // When running against the default user home on macOS, Claude stores auth in Keychain.
  // Sync the active Keychain token into the isolated home if missing or expired.
  if (
    parentHome === join(homedir(), ".claude") &&
    (!existsSync(dest) || claudeCredentialsExpired(dest))
  ) {
    const keychain = claudeReadKeychainCredentials();
    if (keychain) {
      try {
        writeSecret(dest, keychain);
      } catch {
        // Unwritable
      }
    }
  }
}

/**
 * Undoes a bad credential copy, mid-run, when the CLI says it is signed out.
 *
 * The copy above is the launch's weakest link. On macOS the real login normally
 * lives in the keychain and there is no file to copy. But if one was ever
 * written, by an older CLI or an expired session, it stays on disk, gets copied
 * into every launch, and SHADOWS the keychain login the CLI would otherwise
 * find. A perfectly signed-in machine then runs a signed-out agent, forever,
 * and the only symptom is "Not logged in" arriving as the answer to every
 * question.
 *
 * So: drop the copy, which restores whatever fallback the CLI has of its own,
 * and take a fresh one only if the user's file is genuinely newer than what was
 * copied. A login that landed after this launch started is the other way this
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
  // moved from the parent, which would shadow the home's own login with the
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
  } else if (parentHome === join(homedir(), ".claude")) {
    const keychain = claudeReadKeychainCredentials();
    if (keychain) {
      try {
        writeSecret(copied, keychain);
        healed = true;
      } catch {
        // Unwritable
      }
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
 * all. Everything else in that file (hooks, statusLine, outputStyle, model
 * overrides) is exactly what the isolated home exists to keep out.
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
 * A config home is environment variables, not sandbox rules, so it holds
 * whether or not the launch is confined.
 */
const CLAUDE_ISOLATION = () => ({
  isolated: true,
  note: "Runs under a config home Boxaide owns (CLAUDE_CONFIG_DIR), so your own hooks, skills and MCP servers do not load.",
});

/**
 * The `claude` CLI has no listing command. `claude --help` documents --model
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

export const CLAUDE_SPEC: AgentSpec = {
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
  isolation: CLAUDE_ISOLATION,
  renderRunLine: renderClaudeRunLine,
  drive: claudeDrive,
};

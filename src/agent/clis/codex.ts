/** Codex: argv, the per-launch CODEX_HOME, and the config.toml written there. */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chatPreapprovedToolNames,
  kickoffPrompt,
  refreshLink,
  tomlString,
  writeSecret,
  type AgentSpec,
  type LaunchContext,
} from "../spec.js";

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
    // MCP call comes back "user cancelled MCP tool call" (there is nobody to
    // ask) and the run looks alive while doing nothing. This is the only
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
 * package manager, so it is named rather than assumed.
 *
 * Write, not read. A signed-in CLI does not hold a token forever: it refreshes
 * one and saves the new one, and a refresh that cannot save fails the sign-in
 * outright. Read-only here is what made a confined agent unable to
 * authenticate. See `antigravitySandbox` for the case that surfaced it.
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
 * launch is the chat agent or a scheduled run, so the config it writes has to
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

const CODEX_ISOLATION = () => ({
  isolated: true,
  note: "Runs under a config home Boxaide owns (CODEX_HOME), so your own MCP servers do not load.",
});

export const CODEX_SPEC: AgentSpec = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  args: codexArgs,
  runArgs: codexRunArgs,
  childEnv: codexChildEnv,
  prepare: codexPrepare,
  sandbox: codexSandbox,
  isolation: CODEX_ISOLATION,
};

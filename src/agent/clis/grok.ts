/** Grok Build: argv, the per-launch GROK_HOME, and what it writes there. */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readGrokEvent } from "../agent-stream.js";
import { parseBulletModels, type ModelLister } from "../model-list.js";
import {
  chatPreapprovedToolNames,
  kickoffPrompt,
  nativeWebAllowed,
  refreshLink,
  runPreapprovedToolNames,
  tomlString,
  writeSecret,
  type AgentSpec,
  type LaunchContext,
} from "../spec.js";

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
 * from here. The allowlist is the boundary that still holds.
 */
/**
 * Grok's config home lives inside the launch's own working directory, so two
 * overlapping automation runs never share one.
 *
 * Safe to make per-launch because nothing in this home survives a launch that
 * mattered: `grokPrepare` rewrites config.toml and trusted_folders.toml from
 * scratch every time, and auth.json is a link to the user's real one. Claude's
 * home is shared for the opposite reason. See claudeConfigHomeFor.
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
  // run. We neither grant nor deny them. An automation that must look
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

/** Same as codex: grok's linked `auth.json` points back into the user's home. */
function grokSandbox(
  _ctx: LaunchContext,
  _workDir: string,
  env: NodeJS.ProcessEnv,
): { write: string[] } {
  return { write: [env.GROK_HOME || join(env.HOME || homedir(), ".grok")] };
}

const GROK_ISOLATION = () => ({
  isolated: true,
  note: "Runs under a config home Boxaide owns (GROK_HOME), so your own MCP servers do not load.",
});

/** `grok models` prints a bullet list under a prose header. */
const GROK_LISTER: ModelLister = { args: ["models"], parse: parseBulletModels };

export const GROK_SPEC: AgentSpec = {
  id: "grok",
  label: "Grok",
  bin: "grok",
  args: grokArgs,
  runArgs: grokRunArgs,
  listModels: GROK_LISTER,
  childEnv: grokChildEnv,
  prepare: grokPrepare,
  sandbox: grokSandbox,
  isolation: GROK_ISOLATION,
  readEvent: readGrokEvent,
};

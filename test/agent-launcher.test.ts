/**
 * The launcher is tested with a fake registry pointing at real spawnable
 * scripts — never at a real agent CLI, which would burn the user's account
 * and hang the suite.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentLauncher,
  KNOWN_AGENTS,
  LaunchError,
  oneShotDeadlineNote,
  oneShotSilentNote,
  type AgentSpec,
} from "../src/agent/launcher.js";
import { renderClaudeRunLine } from "../src/agent/agent-stream.js";
import { parseTabbedModels } from "../src/agent/model-list.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mailmux-launcher-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A bin directory holding one fake executable that sleeps until killed. */
function fakeBinDir(name: string, script = "#!/bin/sh\nsleep 60\n"): string {
  const dir = join(tempDir(), "bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

const CTX = {
  mcpUrl: "http://127.0.0.1:0/mcp",
  bearerToken: "t",
  dataDir: ":memory:",
};

function specs(over: Partial<AgentSpec> = {}): AgentSpec[] {
  return [
    {
      id: "fake",
      label: "Fake Agent",
      bin: "fake-agent",
      args: () => [],
      ...over,
    },
  ];
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("AgentLauncher", () => {
  it("lists availability from PATH and supported from the registry", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(
      CTX,
      [...specs(), { id: "ghost", label: "Ghost", bin: "not-installed" }],
      { PATH: bin },
    );
    expect((await launcher.list())).toEqual([
      { id: "fake", label: "Fake Agent", available: true, supported: true, models: [] },
      { id: "ghost", label: "Ghost", available: false, supported: false, models: [] },
    ]);
  });

  it("starts, reports running, and stops", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    cleanups.push(() => launcher.close());

    const running = await launcher.start("fake");
    expect(running.id).toBe("fake");
    expect(launcher.status().running?.pid).toBe(running.pid);

    launcher.stop();
    await until(() => launcher.status().running === null);
    expect(launcher.status().lastExit?.id).toBe("fake");
  });

  it("tells the host which agent is running so the conversation can name it", async () => {
    const bin = fakeBinDir("fake-agent");
    const seen: Array<string | null> = [];
    const launcher = new AgentLauncher(
      { ...CTX, onRunningChange: (id) => seen.push(id) },
      specs(),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await launcher.start("fake");
    expect(seen).toEqual(["fake"]);

    launcher.stop();
    await until(() => launcher.status().running === null);
    expect(seen).toEqual(["fake", null]);
  });

  it("refuses a second agent while one runs", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    cleanups.push(() => launcher.close());

    await launcher.start("fake");
    await expect(launcher.start("fake")).rejects.toThrowError(LaunchError);
  });

  it("captures a crash with its stderr tail", async () => {
    const bin = fakeBinDir(
      "fake-agent",
      "#!/bin/sh\necho 'auth expired' >&2\nexit 3\n",
    );
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    cleanups.push(() => launcher.close());

    await launcher.start("fake");
    await until(() => launcher.status().running === null);

    const exit = launcher.status().lastExit;
    expect(exit?.code).toBe(3);
    expect(exit?.stderrTail).toContain("auth expired");
  });

  it("rejects unknown, unsupported and uninstalled agents with API-shaped errors", async () => {
    const launcher = new AgentLauncher(
      CTX,
      [...specs(), { id: "nolaunch", label: "No Launch", bin: "fake-agent" }],
      { PATH: fakeBinDir("fake-agent") },
    );
    await expect(launcher.start("nope")).rejects.toThrowError(/unknown agent/);
    await expect(launcher.start("nolaunch")).rejects.toThrowError(/cannot be launched/);

    const empty = new AgentLauncher(CTX, specs(), { PATH: tempDir() });
    await expect(empty.start("fake")).rejects.toThrowError(/not installed/);
  });

  it("passes only registry model ids to the command line", async () => {
    const bin = fakeBinDir("fake-agent");
    let seenArgs: string[] = [];
    const launcher = new AgentLauncher(
      CTX,
      specs({
        models: [{ id: "model-a", label: "Model A" }],
        args: (_ctx, model) => {
          seenArgs = model ? ["--model", model] : [];
          return seenArgs;
        },
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await expect(launcher.start("fake", "model-b")).rejects.toThrowError(
      /does not offer that model/,
    );

    const running = await launcher.start("fake", "model-a");
    expect(running.model).toBe("model-a");
    expect(seenArgs).toEqual(["--model", "model-a"]);
    expect((await launcher.list())[0].models).toEqual([{ id: "model-a", label: "Model A" }]);
    launcher.stop();
    await until(() => launcher.status().running === null);
  });

  it("lists the models its CLI reports, and only those reach the command line", async () => {
    // The fake CLI answers `models` the way `agy` does, and sleeps otherwise.
    const bin = fakeBinDir(
      "fake-agent",
      `#!/bin/sh
if [ "$1" = "models" ]; then
  printf 'fetching...\\n' >&2
  printf 'live-a\\tLive A\\nlive-b\\tLive B\\n'
  exit 0
fi
sleep 60
`,
    );
    let seenArgs: string[] = [];
    const launcher = new AgentLauncher(
      CTX,
      specs({
        // A stale typed list that must never be shown once the CLI answers.
        models: [{ id: "stale", label: "Stale" }],
        listModels: { args: ["models"], parse: parseTabbedModels },
        args: (_ctx, model) => {
          seenArgs = model ? ["--model", model] : [];
          return seenArgs;
        },
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    expect((await launcher.list())[0].models).toEqual([
      { id: "live-a", label: "Live A" },
      { id: "live-b", label: "Live B" },
    ]);
    await expect(launcher.start("fake", "stale")).rejects.toThrowError(
      /does not offer that model/,
    );

    const running = await launcher.start("fake", "live-b");
    expect(running.model).toBe("live-b");
    expect(seenArgs).toEqual(["--model", "live-b"]);
    launcher.stop();
    await until(() => launcher.status().running === null);
  });

  it("still launches only one agent when two starts race the model check", async () => {
    // `exec`, and an absolute sleep. The launcher's widened PATH has no
    // /usr/bin, so a bare `sleep` is not found and the fake agent would exit
    // at once — this test needs it to stay alive. And without `exec` the
    // sleep is a grandchild that keeps the stdio pipes open after the shell
    // is killed, so "close" never fires and stop() never reports the exit.
    const bin = fakeBinDir(
      "fake-agent",
      `#!/bin/sh
if [ "$1" = "models" ]; then printf 'm1\\tM1\\n'; exit 0; fi
exec /bin/sleep 60
`,
    );
    const launcher = new AgentLauncher(
      CTX,
      specs({ listModels: { args: ["models"], parse: parseTabbedModels } }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    // Validating the model awaits the CLI, and both calls park there before
    // either has spawned. Without a re-check on the way out, both spawn and
    // the first child is orphaned by the second overwriting this.child.
    const settled = await Promise.allSettled([
      launcher.start("fake", "m1"),
      launcher.start("fake", "m1"),
    ]);
    const started = settled.filter((r) => r.status === "fulfilled");
    expect(started).toHaveLength(1);
    expect(launcher.status().running?.pid).toBe(
      (started[0] as PromiseFulfilledResult<{ pid: number }>).value.pid,
    );
    // The loser is refused, not silently ignored.
    const refused = settled.find((r) => r.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(LaunchError);

    // No stop()/until() here on purpose. stop() only sends SIGTERM and waits
    // for the exit event, which makes any test that awaits it hostage to how
    // this platform's /bin/sh hands signals to the process it is waiting on.
    // Teardown has its own test above; the registered close() reaps the child.
  });

  it("serves a poll from an empty answer while a refresh is in flight", async () => {
    // Lists nothing the first time, then hangs — a CLI that loses its network.
    const dir = tempDir();
    const bin = fakeBinDir(
      "fake-agent",
      `#!/bin/sh
if [ "$1" = "models" ]; then
  if [ -f ${join(dir, "once")} ]; then exec /bin/sleep 60; fi
  : > ${join(dir, "once")}
  exit 1
fi
exec /bin/sleep 60
`,
    );
    const launcher = new AgentLauncher(
      CTX,
      specs({ listModels: { args: ["models"], parse: parseTabbedModels } }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    expect((await launcher.list())[0].models).toEqual([]);
    // Age that answer past its TTL, so the next poll serves it and starts a
    // refresh against the now-hanging CLI. Poking the cache directly is the
    // only way to reach that state without sleeping out the failure TTL.
    const cache = (
      launcher as unknown as {
        modelCache: Map<string, { expiresAt: number }>;
      }
    ).modelCache;
    cache.get("fake")!.expiresAt = Date.now() - 1;
    await launcher.list();

    // The poll after that must not wait on the hung refresh. It did before:
    // an empty answer was indistinguishable from never having asked.
    const started = Date.now();
    await launcher.list();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("asks the CLI once and serves the poll from cache", async () => {
    const dir = tempDir();
    const counter = join(dir, "calls");
    const bin = fakeBinDir(
      "fake-agent",
      `#!/bin/sh
if [ "$1" = "models" ]; then
  echo x >> ${counter}
  printf 'live-a\\tLive A\\n'
  exit 0
fi
sleep 60
`,
    );
    const launcher = new AgentLauncher(
      CTX,
      specs({ listModels: { args: ["models"], parse: parseTabbedModels } }),
      { PATH: bin },
    );

    for (let i = 0; i < 3; i++) {
      expect((await launcher.list())[0].models).toEqual([
        { id: "live-a", label: "Live A" },
      ]);
    }
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);

    // An explicit refresh is the only thing that re-runs it inside the TTL.
    launcher.refreshModels();
    await launcher.list();
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("does not let a fetch that a refresh invalidated land in the cache", async () => {
    const dir = tempDir();
    const bin = fakeBinDir(
      "fake-agent",
      `#!/bin/sh
if [ "$1" = "models" ]; then
  if [ -f ${join(dir, "once")} ]; then printf 'second\\tSecond\\n'; exit 0; fi
  : > ${join(dir, "once")}
  printf 'first\\tFirst\\n'
  exit 0
fi
exec /bin/sleep 60
`,
    );
    const launcher = new AgentLauncher(
      CTX,
      specs({ listModels: { args: ["models"], parse: parseTabbedModels } }),
      { PATH: bin },
    );

    // Refresh while the first fetch is still running. Its answer belongs to
    // the state that was just discarded, so it must not repopulate the cache
    // with a full TTL and silently undo the refresh.
    const inFlight = launcher.list();
    launcher.refreshModels();
    await inFlight;

    expect((await launcher.list())[0].models).toEqual([
      { id: "second", label: "Second" },
    ]);
  });

  it("falls back to the typed list when the CLI cannot answer", async () => {
    const bin = fakeBinDir(
      "fake-agent",
      `#!/bin/sh
if [ "$1" = "models" ]; then
  echo 'not logged in' >&2
  exit 1
fi
sleep 60
`,
    );
    const launcher = new AgentLauncher(
      CTX,
      specs({
        models: [{ id: "typed", label: "Typed" }],
        listModels: { args: ["models"], parse: parseTabbedModels },
      }),
      { PATH: bin },
    );
    expect((await launcher.list())[0].models).toEqual([
      { id: "typed", label: "Typed" },
    ]);
  });

  it("rejects a model on an agent that offers none", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    await expect(launcher.start("fake", "anything")).rejects.toThrowError(
      /does not offer that model/,
    );
  });

  it("adds --model to the Claude command line only when picked", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    expect(claude.args!(CTX)).not.toContain("--model");
    const withModel = claude.args!(CTX, "claude-fable-5");
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("claude-fable-5");
    expect(claude.models?.map((m) => m.id)).toContain("claude-fable-5");
  });

  it("does not launch agents whose CLIs cannot enforce per-tool permissions", () => {
    const antigravity = KNOWN_AGENTS.find((s) => s.id === "antigravity")!;
    const opencode = KNOWN_AGENTS.find((s) => s.id === "opencode")!;
    for (const spec of [antigravity, opencode]) {
      expect(spec.args).toBeUndefined();
      expect(spec.runArgs).toBeUndefined();
      expect(spec.prepare).toBeUndefined();
    }
  });

  it("reads Grok's models from its CLI and passes the pick on the command line", () => {
    const grok = KNOWN_AGENTS.find((s) => s.id === "grok")!;
    expect(grok.args!(CTX)).not.toContain("--model");
    const withModel = grok.args!(CTX, "grok-4.6");
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("grok-4.6");
    expect(grok.models).toBeUndefined();
    expect(grok.listModels?.args).toEqual(["models"]);
  });

  it("keeps Claude's bearer out of argv and in a mode-0600 config", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const ctx = {
      mcpUrl: "http://127.0.0.1:8787/mcp",
      bearerToken: "secret-token-xyz",
      dataDir: tempDir(),
    };
    const workDir = join(ctx.dataDir, "agent-workdir");
    mkdirSync(workDir, { recursive: true });
    claude.prepare!(ctx, workDir, {});
    const path = join(workDir, "claude-mcp.json");
    const args = claude.args!(ctx);
    expect(args.join(" ")).not.toContain(ctx.bearerToken);
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(path);
    const content = JSON.parse(readFileSync(path, "utf8"));
    expect(content).toEqual({
      mcpServers: {
        boxaide: {
          type: "http",
          url: ctx.mcpUrl,
          headers: {
            Authorization: `Bearer ${ctx.bearerToken}`,
          },
        },
      },
    });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("pre-approves read and draft tools and never message_send", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code");
    const args = claude!.args!(CTX);
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__boxaide__draft_create");
    expect(allowed).toContain("mcp__boxaide__chat_await_message");
    expect(allowed).not.toContain("message_send");
    // The agent must not inherit the user's other MCP servers.
    expect(args).toContain("--strict-mcp-config");
  });

  it("pre-approves the platform tools for the interactive agent too", () => {
    // The Automations UI tells users to ask the in-app agent to create an
    // automation; before this, only the scheduled path knew those tools.
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const args = claude.args!(CTX);
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__boxaide__automation_create");
    expect(allowed).toContain("mcp__boxaide__crm_contact_upsert");
    expect(allowed).toContain("mcp__boxaide__outbox_queue_draft");
    expect(allowed).not.toContain("mcp__boxaide__message_send");

    const grok = KNOWN_AGENTS.find((s) => s.id === "grok")!;
    const grokArgs = grok.args!(CTX);
    expect(grokArgs).toContain("MCPTool(boxaide__automation_create)");
    expect(grokArgs).toContain("MCPTool(boxaide__crm_contact_upsert)");
    expect(grokArgs.join("\0")).not.toContain("message_send");
  });

  it("asks the chat agent for its event stream, and a run for plain text", () => {
    // The stream is how the Agent pane knows a launched CLI is still working
    // while it does its own file and shell work, calling nothing here.
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const claudeArgs = claude.args!(CTX);
    expect(claudeArgs[claudeArgs.indexOf("--output-format") + 1]).toBe(
      "stream-json",
    );
    expect(claudeArgs).toContain("--verbose");
    expect(claude.readEvent).toBeTypeOf("function");

    const grok = KNOWN_AGENTS.find((s) => s.id === "grok")!;
    const grokArgs = grok.args!(CTX);
    expect(grokArgs[grokArgs.indexOf("--output-format") + 1]).toBe(
      "streaming-json",
    );
    expect(grok.readEvent).toBeTypeOf("function");

    // Grok's run still writes plain text; Claude's `-p` prints nothing at all
    // until it exits, so its run asks for the stream and renders it instead.
    expect(grok.runArgs!(CTX, "do the thing")).not.toContain("--output-format");
    expect(grok.renderRunLine).toBeUndefined();
  });

  it("streams a Claude run so its log is readable while it works", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const args = claude.runArgs!(CTX, "do the thing");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(claude.renderRunLine).toBeTypeOf("function");
    // The run wiring is otherwise untouched.
    expect(args[0]).toBe("-p");
    expect(args).toContain("--strict-mcp-config");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).not.toContain("chat_await_message");
    expect(allowed).not.toContain("message_send");
  });

  it("gives Claude its own config home so a run cannot load the user's setup", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const ctx = { ...CTX, dataDir: tempDir() };
    const workDir = join(ctx.dataDir, "agent-workdir");
    mkdirSync(workDir, { recursive: true });
    const home = join(ctx.dataDir, "agent-homes", "claude");
    expect(claude.childEnv!(ctx, workDir).CLAUDE_CONFIG_DIR).toBe(home);

    // No credentials file (macOS keychain auth): the home exists, empty.
    const bareParent = tempDir();
    claude.prepare!(ctx, workDir, { CLAUDE_CONFIG_DIR: bareParent });
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, ".credentials.json"))).toBe(false);
    expect(existsSync(join(home, "settings.json"))).toBe(false);

    // With one, it is copied so the isolated home still authenticates. Never a
    // symlink: the CLI rewrites this file on a token refresh, and through a
    // link that write would land in the user's own ~/.claude.
    writeFileSync(join(bareParent, ".credentials.json"), '{"token":"x"}');
    claude.prepare!(ctx, workDir, { CLAUDE_CONFIG_DIR: bareParent });
    const copied = join(home, ".credentials.json");
    expect(lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(readFileSync(copied, "utf8")).toBe('{"token":"x"}');

    // And it is refreshed per launch, so a rotated token is not left behind.
    writeFileSync(join(bareParent, ".credentials.json"), '{"token":"y"}');
    claude.prepare!(ctx, workDir, { CLAUDE_CONFIG_DIR: bareParent });
    expect(readFileSync(copied, "utf8")).toBe('{"token":"y"}');
  });

  it("carries only Claude's auth settings across the isolation boundary", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    /** Prepares a fresh isolated home against the given parent settings.json. */
    function prepareWith(settings: string | null): string {
      const ctx = { ...CTX, dataDir: tempDir() };
      const workDir = join(ctx.dataDir, "agent-workdir");
      mkdirSync(workDir, { recursive: true });
      const parent = tempDir();
      if (settings !== null) {
        writeFileSync(join(parent, "settings.json"), settings);
      }
      claude.prepare!(ctx, workDir, { CLAUDE_CONFIG_DIR: parent });
      return join(ctx.dataDir, "agent-homes", "claude", "settings.json");
    }

    // Users who authenticate through settings.json have no credentials file at
    // all, so `env` and `apiKeyHelper` must survive isolation. Nothing else
    // does — hooks and statusLine are what the isolated home exists to exclude.
    const written = prepareWith(
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        apiKeyHelper: "/bin/echo sk-test",
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
        statusLine: { type: "command", command: "whoami" },
        outputStyle: "ste",
        model: "claude-opus-5",
      }),
    );
    expect(JSON.parse(readFileSync(written, "utf8"))).toEqual({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      apiKeyHelper: "/bin/echo sk-test",
    });

    // Nothing to carry, no file at all: absent, auth-free, and malformed all
    // leave the isolated home alone instead of failing the launch.
    expect(existsSync(prepareWith(null))).toBe(false);
    expect(existsSync(prepareWith('{"hooks":{},"outputStyle":"ste"}'))).toBe(false);
    expect(existsSync(prepareWith("{ not json"))).toBe(false);
  });

  it("leaves Grok's own web tools at the CLI default on a one-shot run", () => {
    const grok = KNOWN_AGENTS.find((s) => s.id === "grok")!;
    expect(grok.runArgs!(CTX, "do the thing")).not.toContain(
      "--disable-web-search",
    );
    // The chat loop keeps its existing behavior.
    expect(grok.args!(CTX)).toContain("--disable-web-search");
  });

  it("launches Grok with an isolated config and a boxaide-only allowlist", () => {
    const grok = KNOWN_AGENTS.find((s) => s.id === "grok");
    expect(grok?.args).toBeTypeOf("function");
    const ctx = {
      mcpUrl: "http://127.0.0.1:8787/mcp",
      bearerToken: "secret-token-xyz",
      dataDir: tempDir(),
    };
    const args = grok!.args!(ctx);
    expect(args[0]).toBe("-p");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain("--allow");
    expect(args).toContain("MCPTool(boxaide__draft_create)");
    expect(args).toContain("MCPTool(boxaide__chat_await_message)");
    expect(args.join("\0")).not.toContain("message_send");
    expect(args.join("\0")).not.toContain(ctx.bearerToken);

    const workDir = join(ctx.dataDir, "agent-workdir");
    mkdirSync(workDir, { recursive: true });
    grok!.prepare!(ctx, workDir, { PATH: "/usr/bin" });
    const env = grok!.childEnv!(ctx, workDir);
    expect(env.BOXAIDE_TOKEN).toBe(ctx.bearerToken);
    expect(env.GROK_HOME).toBe(join(ctx.dataDir, "agent-homes", "grok"));
    expect(env.GROK_CLAUDE_MCPS_ENABLED).toBe("0");
    expect(env.GROK_CURSOR_MCPS_ENABLED).toBe("0");

    const toml = readFileSync(join(env.GROK_HOME, "config.toml"), "utf8");
    expect(toml).toContain(ctx.mcpUrl);
    expect(toml).toContain("[mcp_servers.boxaide]");
    expect(toml).toContain("BOXAIDE_TOKEN");
    expect(toml).toContain("bearer_token_env_var");
    expect(toml).not.toContain(ctx.bearerToken);
    expect(toml).toMatch(/compat\.claude[\s\S]*mcps = false/);
    expect(readFileSync(join(workDir, ".grok", "config.toml"), "utf8")).toContain(
      ctx.mcpUrl,
    );
  });

  it("starts a fake grok binary after writing its isolated home", async () => {
    const dataDir = tempDir();
    const bin = fakeBinDir("grok");
    const grok = KNOWN_AGENTS.find((s) => s.id === "grok")!;
    const launcher = new AgentLauncher(
      { mcpUrl: "http://127.0.0.1:9/mcp", bearerToken: "secret-token-xyz", dataDir },
      [grok],
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    const running = await launcher.start("grok");
    expect(running.id).toBe("grok");
    const home = join(dataDir, "agent-homes", "grok");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
      "http://127.0.0.1:9/mcp",
    );
    launcher.stop();
    await until(() => launcher.status().running === null);
  });
});

describe("one-shot automation runs", () => {
  /**
   * A launcher over one fake CLI that carries runs. Streaming by default —
   * `renderRunLine` is what arms the first-output watchdog, so a spec without
   * it stands in for the CLIs that print nothing until they are done.
   */
  function runner(script: string, streaming = true): AgentLauncher {
    const bin = fakeBinDir("fake-agent", script);
    const launcher = new AgentLauncher(
      CTX,
      specs({
        runArgs: () => [],
        ...(streaming ? { renderRunLine: renderClaudeRunLine } : {}),
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());
    return launcher;
  }

  it("renders a stream-json run into a log a person can read", async () => {
    const launcher = runner(
      `#!/bin/sh
printf '{"type":"system","subtype":"init","model":"claude-opus-5"}\\n'
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__boxaide__messages_list"}]}}\\n'
printf '{"type":"result","subtype":"success","result":"filed two threads"}\\n'
`,
    );
    const result = await launcher.runOnce({ prompt: "do the thing" });
    expect(result.status).toBe("ok");
    expect(result.log).toContain("[claude] session started (model claude-opus-5)");
    expect(result.log).toContain("[tool] messages_list");
    expect(result.log).toContain("[claude] result: filed two threads");
    // The raw NDJSON never reaches the log.
    expect(result.log).not.toContain('"type":"assistant"');
  });

  it("kills a run that never writes anything, and says so", async () => {
    const launcher = runner("#!/bin/sh\nexec /bin/sleep 30\n");
    const result = await launcher.runOnce({
      prompt: "do the thing",
      firstOutputTimeoutMs: 200,
    });
    // 'error', not 'killed': a run that never spoke did not start.
    expect(result.status).toBe("error");
    expect(result.log).toContain(oneShotSilentNote(200));
  });

  it("lets a run that already spoke wait for the deadline", async () => {
    // First stdout disarms the watchdog. A quiet stretch after that is a long
    // tool, not a hang; only the deadline may stop it.
    const launcher = runner("#!/bin/sh\necho working\nexec /bin/sleep 30\n");
    const result = await launcher.runOnce({
      prompt: "do the thing",
      firstOutputTimeoutMs: 400,
      timeoutMs: 900,
    });
    expect(result.status).toBe("killed");
    expect(result.log).toContain("working");
    expect(result.log).toContain(oneShotDeadlineNote(900));
    expect(result.log).not.toContain(oneShotSilentNote(400));
  });

  it("leaves a run that spoke once alone, even when it then goes quiet", async () => {
    const launcher = runner(
      "#!/bin/sh\necho working\n/bin/sleep 0.8\necho done\n",
    );
    const result = await launcher.runOnce({
      prompt: "do the thing",
      firstOutputTimeoutMs: 400,
    });
    expect(result.status).toBe("ok");
    expect(result.log).toContain("working");
    expect(result.log).toContain("done");
    expect(result.log).not.toContain("[boxaide] stopped");
  });

  it("does not watch a run whose CLI never narrates itself", async () => {
    // Antigravity, OpenCode and Grok runs print nothing until they finish.
    // Silence is their healthy state, and killing them for it killed real runs.
    const launcher = runner("#!/bin/sh\n/bin/sleep 1\necho done\n", false);
    const result = await launcher.runOnce({
      prompt: "do the thing",
      firstOutputTimeoutMs: 200,
    });
    expect(result.status).toBe("ok");
    expect(result.log).toContain("done");
    expect(result.log).not.toContain("[boxaide] stopped");
  });

  it("does not let stderr noise stand in for the agent speaking", async () => {
    // Update checks and deprecation warnings arrive on stderr from a process
    // whose session never started. Only stdout is the agent working.
    const launcher = runner(
      `#!/bin/sh
i=0
while [ $i -lt 25 ]; do echo noise >&2; /bin/sleep 0.1; i=$((i+1)); done
exec /bin/sleep 30
`,
    );
    const started = Date.now();
    const result = await launcher.runOnce({
      prompt: "do the thing",
      firstOutputTimeoutMs: 300,
      closeGraceMs: 300,
    });
    expect(result.status).toBe("error");
    expect(result.log).toContain(oneShotSilentNote(300));
    // The kill lands while the noise is still flowing. Elapsed is the whole
    // assertion: a timer fed by stderr would instead run out the 2.5s of it.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("keeps a killed run's unfinished last line in the log", async () => {
    // No trailing newline, so the splitter is still holding it when the kill
    // lands. It is the best evidence of what the run was doing when it died.
    const launcher = runner(
      "#!/bin/sh\nprintf 'halfway through a thought'\nexec /bin/sleep 30\n",
    );
    const result = await launcher.runOnce({
      prompt: "do the thing",
      timeoutMs: 400,
      firstOutputTimeoutMs: 10_000,
    });
    expect(result.status).toBe("killed");
    expect(result.log).toContain("halfway through a thought");
  });

  it("explains a deadline kill in the log with the deadline it actually used", async () => {
    const launcher = runner("#!/bin/sh\nexec /bin/sleep 30\n");
    const result = await launcher.runOnce({
      prompt: "do the thing",
      timeoutMs: 200,
      firstOutputTimeoutMs: 10_000,
    });
    expect(result.status).toBe("killed");
    expect(result.log).toContain(oneShotDeadlineNote(200));
    // The note states the real window, not a hardcoded 15 minutes.
    expect(result.log).toContain("0.2-second");
    expect(oneShotDeadlineNote(15 * 60 * 1000)).toContain("15-minute");
  });

  it("finishes when the agent exits, not when the last pipe holder does", async () => {
    // A detached grandchild inherits stdout and keeps it open long after the
    // agent is gone. Waiting for "close" reported that wait as run duration.
    const launcher = runner("#!/bin/sh\n/bin/sleep 3 &\necho done\nexit 0\n");
    const started = Date.now();
    const result = await launcher.runOnce({
      prompt: "do the thing",
      closeGraceMs: 200,
    });
    expect(result.status).toBe("ok");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("launcher routes", () => {
  it("requires auth, lists agents, and maps LaunchError to its status", async () => {
    const { createRuntime } = await import("../src/app.js");
    const { Store } = await import("../src/db/store.js");
    const { FixtureProvider } = await import("../src/provider/fixture.js");
    const { randomBytes } = await import("node:crypto");
    const runtime = createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: "route-test-token-123",
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      allowedOrigins: [],
      store: new Store(randomBytes(32), ":memory:"),
      provider: new FixtureProvider(),
    });
    const auth = { Authorization: "Bearer route-test-token-123" };

    const denied = await runtime.app.request("/api/agents");
    expect(denied.status).toBe(401);

    const listed = await runtime.app.request("/api/agents", { headers: auth });
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.running).toBeNull();
    expect(body.agents.map((a: { id: string }) => a.id)).toContain("claude-code");
    expect(body.agents.map((a: { id: string }) => a.id)).toContain("antigravity");
    expect(body.agents.map((a: { id: string }) => a.id)).toContain("opencode");
    expect(body.agents.map((a: { id: string }) => a.id)).not.toContain("gemini");
    expect(body.agents.find((a: { id: string }) => a.id === "antigravity")?.supported).toBe(
      false,
    );
    expect(body.agents.find((a: { id: string }) => a.id === "opencode")?.supported).toBe(
      false,
    );
    expect(body.agents.find((a: { id: string }) => a.id === "grok")?.supported).toBe(
      true,
    );

    const unknown = await runtime.app.request("/api/agents/nope/start", {
      method: "POST",
      headers: auth,
    });
    expect(unknown.status).toBe(404);

    // Registered but has no launch recipe — 400 regardless of what is
    // installed on the machine running this suite.
    const unsupported = await runtime.app.request("/api/agents/codex/start", {
      method: "POST",
      headers: auth,
    });
    expect(unsupported.status).toBe(400);

    // A bad model is rejected before anything spawns, so these are safe to
    // hit even on a machine with the real CLI installed.
    const badModelType = await runtime.app.request(
      "/api/agents/claude-code/start",
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ model: 123 }),
      },
    );
    expect(badModelType.status).toBe(400);

    const unknownModel = await runtime.app.request(
      "/api/agents/claude-code/start",
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "not-a-registry-model" }),
      },
    );
    expect(unknownModel.status).toBe(400);
    // Which of the two rejections lands depends on whether the CLI is on this
    // machine: validating a model means asking that CLI what it offers, so a
    // missing binary is reported first. Both refuse, and neither spawns.
    expect((await unknownModel.json()).error).toMatch(
      /does not offer|is not installed/,
    );

    const stopped = await runtime.app.request("/api/agents/stop", {
      method: "POST",
      headers: auth,
    });
    expect(stopped.status).toBe(200);

    runtime.launcher.close();
    runtime.channel.close();
    runtime.store.close();
  });
});

describe("GUI PATH detection", () => {
  it("finds agents in well-known directories when PATH is launchd-minimal", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(
      CTX,
      specs(),
      { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      [bin], // stands in for ~/.local/bin etc.
    );
    expect((await launcher.list())[0].available).toBe(true);

    // And the launched child gets the widened PATH, not launchd's.
    const running = await launcher.start("fake");
    expect(running.id).toBe("fake");
    launcher.close();
  });
});

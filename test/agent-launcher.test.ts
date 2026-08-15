/**
 * The launcher is tested with a fake registry pointing at real spawnable
 * scripts — never at a real agent CLI, which would burn the user's account
 * and hang the suite.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentLauncher,
  KNOWN_AGENTS,
  LaunchError,
  type AgentSpec,
} from "../src/agent/launcher.js";

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
  it("lists availability from PATH and supported from the registry", () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(
      CTX,
      [...specs(), { id: "ghost", label: "Ghost", bin: "not-installed" }],
      { PATH: bin },
    );
    expect(launcher.list()).toEqual([
      { id: "fake", label: "Fake Agent", available: true, supported: true, models: [] },
      { id: "ghost", label: "Ghost", available: false, supported: false, models: [] },
    ]);
  });

  it("starts, reports running, and stops", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    cleanups.push(() => launcher.close());

    const running = launcher.start("fake");
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

    launcher.start("fake");
    expect(seen).toEqual(["fake"]);

    launcher.stop();
    await until(() => launcher.status().running === null);
    expect(seen).toEqual(["fake", null]);
  });

  it("refuses a second agent while one runs", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    cleanups.push(() => launcher.close());

    launcher.start("fake");
    expect(() => launcher.start("fake")).toThrowError(LaunchError);
  });

  it("captures a crash with its stderr tail", async () => {
    const bin = fakeBinDir(
      "fake-agent",
      "#!/bin/sh\necho 'auth expired' >&2\nexit 3\n",
    );
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    cleanups.push(() => launcher.close());

    launcher.start("fake");
    await until(() => launcher.status().running === null);

    const exit = launcher.status().lastExit;
    expect(exit?.code).toBe(3);
    expect(exit?.stderrTail).toContain("auth expired");
  });

  it("rejects unknown, unsupported and uninstalled agents with API-shaped errors", () => {
    const launcher = new AgentLauncher(
      CTX,
      [...specs(), { id: "nolaunch", label: "No Launch", bin: "fake-agent" }],
      { PATH: fakeBinDir("fake-agent") },
    );
    expect(() => launcher.start("nope")).toThrowError(/unknown agent/);
    expect(() => launcher.start("nolaunch")).toThrowError(/cannot be launched/);

    const empty = new AgentLauncher(CTX, specs(), { PATH: tempDir() });
    expect(() => empty.start("fake")).toThrowError(/not installed/);
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

    expect(() => launcher.start("fake", "model-b")).toThrowError(
      /does not offer that model/,
    );

    const running = launcher.start("fake", "model-a");
    expect(running.model).toBe("model-a");
    expect(seenArgs).toEqual(["--model", "model-a"]);
    expect(launcher.list()[0].models).toEqual([{ id: "model-a", label: "Model A" }]);
    launcher.stop();
    await until(() => launcher.status().running === null);
  });

  it("rejects a model on an agent that offers none", () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    expect(() => launcher.start("fake", "anything")).toThrowError(
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

  it("adds --model to Antigravity and OpenCode command lines only when picked", () => {
    const antigravity = KNOWN_AGENTS.find((s) => s.id === "antigravity")!;
    expect(antigravity.args!(CTX)).not.toContain("--model");
    const agyWithModel = antigravity.args!(CTX, "gemini-2.5-pro");
    expect(agyWithModel[agyWithModel.indexOf("--model") + 1]).toBe("gemini-2.5-pro");
    expect(antigravity.models?.map((m) => m.id)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ]);

    const opencode = KNOWN_AGENTS.find((s) => s.id === "opencode")!;
    // The chat launch is a server now, so the pick reaches the model over the
    // API per prompt, not on the command line. Automations still pin it in
    // argv: OpenCode's own default retries forever when that endpoint is down.
    expect(opencode.args!(CTX)).not.toContain("--model");
    const opencodeRun = opencode.runArgs!(CTX, "do the thing");
    expect(opencodeRun[opencodeRun.indexOf("--model") + 1]).toBe("opencode/big-pickle");
    const opencodeWithModel = opencode.runArgs!(CTX, "do the thing", "openai/gpt-5.4");
    expect(opencodeWithModel[opencodeWithModel.indexOf("--model") + 1]).toBe("openai/gpt-5.4");
    expect(opencode.models?.map((m) => m.id)).toEqual([
      "opencode/big-pickle",
      "opencode/hy3-free",
      "opencode/laguna-s-2.1-free",
      "opencode/mimo-v2.5-free",
      "opencode/nemotron-3-ultra-free",
      "opencode/nemotron-3.5-lightning-free",
      "openai/gpt-5.4",
      "github-copilot/claude-sonnet-5",
    ]);
  });

  it("writes valid opencode.json config for OpenCode", () => {
    const opencode = KNOWN_AGENTS.find((s) => s.id === "opencode")!;
    expect(opencode.prepare).toBeTypeOf("function");
    const ctx = {
      mcpUrl: "http://127.0.0.1:8787/mcp",
      bearerToken: "secret-token-xyz",
      dataDir: tempDir(),
    };
    const workDir = join(ctx.dataDir, "agent-workdir");
    mkdirSync(workDir, { recursive: true });
    opencode.prepare!(ctx, workDir, {});
    const content = JSON.parse(readFileSync(join(workDir, "opencode.json"), "utf8"));
    expect(content).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "opencode/big-pickle",
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
    });
  });

  it("launches OpenCode pinned to the empty workdir with an isolated config", () => {
    const opencode = KNOWN_AGENTS.find((s) => s.id === "opencode")!;
    const ctx = {
      mcpUrl: "http://127.0.0.1:8787/mcp",
      bearerToken: "secret-token-xyz",
      dataDir: tempDir(),
    };
    const workDir = join(ctx.dataDir, "agent-workdir");
    // Chat runs the server; the driver holds the loop and passes --dir's job
    // as ?directory= per call.
    const args = opencode.args!(ctx);
    expect(args[0]).toBe("--pure");
    expect(args).toContain("serve");
    expect(args[args.indexOf("--port") + 1]).toBe("0");
    expect(args[args.indexOf("--hostname") + 1]).toBe("127.0.0.1");
    expect(opencode.drive).toBeTypeOf("function");
    expect(opencode.readEvent).toBeTypeOf("function");

    mkdirSync(workDir, { recursive: true });
    opencode.prepare!(ctx, workDir, {});
    const env = opencode.childEnv!(ctx, workDir);
    expect(env.XDG_CONFIG_HOME).toBe(join(ctx.dataDir, "agent-homes", "opencode", "config"));
    expect(env.OPENCODE_CONFIG).toBe(join(workDir, "opencode.json"));
    // A fresh server password per launch, readable by the driver.
    expect(env.OPENCODE_SERVER_PASSWORD).toBeTruthy();
    expect(opencode.childEnv!(ctx, workDir).OPENCODE_SERVER_PASSWORD).not.toBe(
      env.OPENCODE_SERVER_PASSWORD,
    );
    // The automation path is unchanged: still a one-shot `run`.
    expect(opencode.runArgs!(ctx, "do the thing")).toContain("run");
    expect(opencode.runArgs!(ctx, "do the thing")[
      opencode.runArgs!(ctx, "do the thing").indexOf("--dir") + 1
    ]).toBe(workDir);
    expect(opencode.runArgs!(ctx, "do the thing")).toContain("--dir");
    expect(opencode.runArgs!(ctx, "do the thing")).not.toContain("--format");
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

    // A scheduled run has no pane to update, and its log is read by a human.
    expect(claude.runArgs!(CTX, "do the thing")).not.toContain("--output-format");
    expect(grok.runArgs!(CTX, "do the thing")).not.toContain("--output-format");
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

    const running = launcher.start("grok");
    expect(running.id).toBe("grok");
    const home = join(dataDir, "agent-homes", "grok");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
      "http://127.0.0.1:9/mcp",
    );
    launcher.stop();
    await until(() => launcher.status().running === null);
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
      true,
    );
    expect(body.agents.find((a: { id: string }) => a.id === "opencode")?.supported).toBe(
      true,
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

    // Model validation happens before anything resolves or spawns, so these
    // are safe to hit even on a machine with the real CLI installed.
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
    expect((await unknownModel.json()).error).toMatch(/does not offer/);

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
  it("finds agents in well-known directories when PATH is launchd-minimal", () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(
      CTX,
      specs(),
      { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      [bin], // stands in for ~/.local/bin etc.
    );
    expect(launcher.list()[0].available).toBe(true);

    // And the launched child gets the widened PATH, not launchd's.
    const running = launcher.start("fake");
    expect(running.id).toBe("fake");
    launcher.close();
  });
});

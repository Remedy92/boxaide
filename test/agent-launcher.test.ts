/**
 * The launcher is tested with a fake registry pointing at real spawnable
 * scripts — never at a real agent CLI, which would burn the user's account
 * and hang the suite.
 */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentLauncher,
  KNOWN_AGENTS,
  LaunchError,
  claudeCopyCredentials,
  claudeHealCredentials,
  claudeTurnArgs,
  oneShotDeadlineNote,
  oneShotSilentNote,
  type AgentSpec,
  type DriveOptions,
} from "../src/agent/launcher.js";
import { renderClaudeRunLine } from "../src/agent/agent-stream.js";
import { DRIVEN_SYSTEM, type DriverChannel } from "../src/agent/driver.js";
import { parseTabbedModels } from "../src/agent/model-list.js";
import { claudeLoginScript, watchForClaudeSignIn } from "../src/api/routes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mailmux-launcher-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Read a path that must be a regular file, not a symlink. */
function readRegular(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * A stand-in agent binary on a PATH that holds nothing else.
 *
 * Both halves of the default script are load-bearing. `/bin/sleep` by absolute
 * path, because the launcher hands the child a PATH built from the one it was
 * given plus its well-known bin directories, and on a CI runner none of those
 * holds `sleep` — the fake agent then died instantly with 127 and raced every
 * test that expects it to stay up. `exec`, because otherwise the sleep is a
 * grandchild that keeps the stdio pipes open after the shell is signalled, so
 * "close" never fires and the launcher never reports the exit.
 */
function fakeBinDir(
  name: string,
  script = "#!/bin/sh\nexec /bin/sleep 60\n",
): string {
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
  // "full" so the suite describes launching, not confining, and runs the same
  // on every platform — a workspace launch is refused off macOS by design.
  // Confinement has its own file: test/agent-sandbox.test.ts.
  access: "full" as const,
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

/**
 * Enough of the channel to satisfy a spec's `drive`. The launcher only checks
 * that one is there; what a driver does with it is the driver tests' business.
 */
function fakeChannel(): DriverChannel {
  return {
    awaitUserTurn: () => new Promise(() => {}),
    answer: () => true,
    releaseLease: () => "released",
    noteAgentActivity: () => {},
    setDriven: () => {},
    needsTitle: () => false,
    nameChat: () => false,
    chatSession: () => ({ id: null, epoch: 0 }),
    saveChatSession: () => {},
    clearChatSession: () => {},
  };
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
      {
        id: "fake",
        label: "Fake Agent",
        available: true,
        supported: true,
        // No runArgs on the test spec: launchable for chat, not for a run.
        runsAutomations: false,
        models: [],
      },
      {
        id: "ghost",
        label: "Ghost",
        available: false,
        supported: false,
        runsAutomations: false,
        models: [],
      },
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

  it("runs a driven agent that has no child of its own", async () => {
    const bin = fakeBinDir("fake-agent");
    const seen: Array<string | null> = [];
    let stop!: (error: string | null) => void;
    let stopped = 0;
    let handed!: DriveOptions;
    const launcher = new AgentLauncher(
      { ...CTX, channel: fakeChannel(), onRunningChange: (id) => seen.push(id) },
      specs({
        args: undefined,
        drive: (_ctx, opts) => {
          handed = opts;
          stop = opts.onStop;
          return {
            // Idempotent, as the AgentDriver contract requires, and reporting
            // the end of its loop from inside stop() — which for an agent with
            // no child is the only exit there is.
            stop: () => {
              if (stopped > 0) return;
              stopped += 1;
              opts.onStop(null);
            },
          };
        },
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    const running = await launcher.start("fake");
    expect(seen).toEqual(["fake"]);
    // Nothing was spawned, so there is no one process to name.
    expect(running.pid).toBe(-1);
    expect(launcher.status().running?.id).toBe("fake");
    expect(launcher.chatBusy()).toBe(true);
    // The driver spawns its own children, so it is handed the binary and the
    // full environment a launcher spawn would have used.
    expect(handed.child).toBeNull();
    expect(handed.bin).toBe(join(bin, "fake-agent"));
    expect(handed.env.PATH).toContain(bin);
    expect(stop).toBeTypeOf("function");

    launcher.stop();
    await until(() => launcher.status().running === null);
    expect(stopped).toBe(1);
    expect(seen).toEqual(["fake", null]);
    // Asked for, so not a crash — and no invented exit code: a loop is not a
    // process, and the rail reads the reason.
    expect(launcher.status().lastExit).toMatchObject({
      id: "fake",
      code: null,
      reason: "stopped",
    });
  });

  it("reports a driver that gave up as an exit the pane can explain", async () => {
    const bin = fakeBinDir("fake-agent");
    let give!: (error: string | null) => void;
    const launcher = new AgentLauncher(
      { ...CTX, channel: fakeChannel() },
      specs({
        args: undefined,
        drive: (_ctx, opts) => {
          give = opts.onStop;
          return { stop: () => {} };
        },
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await launcher.start("fake");
    give("Invalid API key");
    await until(() => launcher.status().running === null);

    const exit = launcher.status().lastExit;
    expect(exit?.reason).toBe("error");
    expect(exit?.code).toBeNull();
    expect(exit?.stderrTail).toContain("Invalid API key");
    // A give-up that said nothing about auth is not a sign-out, and the pane
    // must not offer a login for it.
    expect(exit?.authRequired).toBe(false);
  });

  it("carries a sign-out into the exit record as its own field", async () => {
    const bin = fakeBinDir("fake-agent");
    let give!: DriveOptions["onStop"];
    const launcher = new AgentLauncher(
      { ...CTX, channel: fakeChannel() },
      specs({
        args: undefined,
        drive: (_ctx, opts) => {
          give = opts.onStop;
          return { stop: () => {} };
        },
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await launcher.start("fake");
    give("claude is not signed in: run `claude /login`", { authRequired: true });
    await until(() => launcher.status().running === null);

    const exit = launcher.status().lastExit;
    expect(exit?.reason).toBe("error");
    // The field, not the sentence: the pane's sign-in button must keep working
    // the day the CLI rewords its notice.
    expect(exit?.authRequired).toBe(true);
  });

  it("reports a clean stop as a stop even when the driver names a sign-out", async () => {
    const bin = fakeBinDir("fake-agent");
    let give!: DriveOptions["onStop"];
    const launcher = new AgentLauncher(
      { ...CTX, channel: fakeChannel() },
      specs({
        args: undefined,
        drive: (_ctx, opts) => {
          give = opts.onStop;
          return { stop: () => {} };
        },
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await launcher.start("fake");
    give(null, { authRequired: true });
    await until(() => launcher.status().running === null);

    expect(launcher.status().lastExit?.reason).toBe("stopped");
    expect(launcher.status().lastExit?.authRequired).toBe(false);
  });

  it("does not leave a running agent behind when its driver cannot start", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(
      { ...CTX, channel: fakeChannel() },
      specs({
        args: undefined,
        drive: () => {
          throw new Error("no session store");
        },
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    // The launch fails as a launch, rather than reporting an agent that answers
    // nothing: `running` stuck true would 409 every later start and block the
    // scheduler until the app restarted.
    await expect(launcher.start("fake")).rejects.toThrowError(/no session store/);
    expect(launcher.status().running).toBeNull();
    expect(launcher.chatBusy()).toBe(false);
    expect(launcher.status().lastExit).toMatchObject({
      id: "fake",
      reason: "error",
    });
    expect(launcher.status().lastExit?.stderrTail).toContain("no session store");
    // And the slot is free, so the next start works.
    const again = new AgentLauncher(
      { ...CTX, channel: fakeChannel() },
      specs({ args: undefined, drive: () => ({ stop: () => {} }) }),
      { PATH: bin },
    );
    cleanups.push(() => again.close());
    await expect(again.start("fake")).resolves.toMatchObject({ id: "fake" });
  });

  it("does not wedge when a driven-only spec's driver declines", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(
      // A channel is there, so the guard at the top of start() passes and the
      // decline can only be seen after the launch was recorded.
      { ...CTX, channel: fakeChannel() },
      specs({ args: undefined, drive: () => null }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await expect(launcher.start("fake")).rejects.toThrowError(
      /could not start its loop/,
    );
    expect(launcher.status().running).toBeNull();
    expect(launcher.chatBusy()).toBe(false);
  });

  it("refuses a driven launch in a process with no conversation", async () => {
    // A driven agent is nothing but its loop, and a loop needs a channel to
    // wait on. Reporting a running agent that answers nothing is worse.
    const launcher = new AgentLauncher(
      CTX,
      specs({ args: undefined, drive: () => null }),
      { PATH: fakeBinDir("fake-agent") },
    );
    await expect(launcher.start("fake")).rejects.toThrowError(
      /needs the Boxaide conversation/,
    );
    expect(launcher.status().running).toBeNull();
    expect((await launcher.list())[0].supported).toBe(true);
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
    // Nobody asked for this one, so the rail is right to call it out.
    expect(exit?.reason).toBe("exited");
    expect(exit?.stderrTail).toContain("auth expired");
  });

  it("records a stop as stopped even though the child dies on a signal", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(CTX, specs(), { PATH: bin });
    cleanups.push(() => launcher.close());

    await launcher.start("fake");
    launcher.stop();
    await until(() => launcher.status().running === null);

    const exit = launcher.status().lastExit;
    // SIGTERM leaves no exit code, so the code alone cannot tell this from a
    // crash. Only the launcher knows it was asked.
    expect(exit?.code).toBeNull();
    expect(exit?.reason).toBe("stopped");
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
exec /bin/sleep 60
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
exec /bin/sleep 60
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
exec /bin/sleep 60
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

  it("launches Claude Code as a driver with no long-lived child", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    // `claude` has no server mode, so there is nothing to keep running: the
    // driver spawns one `-p` process per user turn and resumes across them.
    expect(claude.args).toBeUndefined();
    expect(claude.drive).toBeTypeOf("function");
    // Automations are unchanged — a one-shot prompt already exits when done.
    expect(claude.runArgs).toBeTypeOf("function");
  });

  it("adds --model to a Claude turn's command line only when picked", () => {
    const turn = { prompt: "what came in?", system: "be brief", sessionId: null };
    expect(claudeTurnArgs(CTX, turn)).not.toContain("--model");
    const withModel = claudeTurnArgs(CTX, turn, "claude-fable-5");
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("claude-fable-5");
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    expect(claude.models?.map((m) => m.id)).toContain("claude-fable-5");
  });

  it("carries the user turn, the framing and the session on a Claude turn", () => {
    const fresh = claudeTurnArgs(CTX, {
      prompt: "what came in?",
      system: "be brief",
      sessionId: null,
    });
    // Last, and behind `--`: the prompt is a positional argument and it is the
    // user's text verbatim, so option parsing has to be closed first.
    expect(fresh.slice(-2)).toEqual(["--", "what came in?"]);
    expect(fresh[fresh.indexOf("--append-system-prompt") + 1]).toBe("be brief");
    // Nothing to resume yet, and the stream is what the driver reads the
    // session id, the answer and the presence lines out of.
    expect(fresh).not.toContain("--resume");
    expect(fresh[fresh.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(fresh).toContain("--verbose");

    const resumed = claudeTurnArgs(CTX, {
      prompt: "anything else?",
      system: "be brief",
      sessionId: "ses-1",
    });
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("ses-1");
  });

  it("hands a dash-leading message to the CLI as a prompt, not as options", () => {
    // Verified against claude 2.1.233: `-p` is a boolean flag and the prompt is
    // positional, so `-p --version` prints the version and exits and `-p --help
    // hi` fails with "unknown option". A chat message may begin with anything.
    const turn = claudeTurnArgs(CTX, {
      prompt: "--version --help  what came in?",
      system: "be brief",
      sessionId: "ses-1",
    });
    expect(turn.slice(-2)).toEqual(["--", "--version --help  what came in?"]);
    // Exactly one terminator, and nothing after the prompt that could be read
    // as a flag.
    expect(turn.filter((arg) => arg === "--")).toHaveLength(1);

    // Automations get the same treatment. Their prompt opens with the run
    // preamble today, which is the only reason this was not already breaking.
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const run = claude.runArgs!(CTX, "--dangerously-skip-permissions", "/tmp/run-dir");
    expect(run.slice(-2)).toEqual(["--", "--dangerously-skip-permissions"]);
  });

  it("hands each launch its own scoped credential and takes it back on exit", async () => {
    const { ScopedTokens } = await import("../src/mcp/scoped-tokens.js");
    const tokens = new ScopedTokens();
    const bin = fakeBinDir("fake-agent");
    // What the spec was actually given, captured off the command line.
    let sawToken: string | null = null;
    const launcher = new AgentLauncher(
      { ...CTX, mintToken: (profile, label) => tokens.mint(profile, label) },
      specs({
        args: (ctx) => {
          sawToken = ctx.bearerToken;
          return [];
        },
      }),
      { PATH: "" },
      [bin],
    );

    await launcher.start("fake");
    expect(sawToken).not.toBe(CTX.bearerToken);
    expect(tokens.resolve(sawToken!)).toBe("chat");
    expect(tokens.list()).toHaveLength(1);

    launcher.close();
    // Revoked the moment the launch ends, not when the process finally dies:
    // a child that ignores SIGTERM must not keep a working credential.
    expect(tokens.resolve(sawToken!)).toBeNull();
    expect(tokens.list()).toHaveLength(0);
  });

  it("scopes a scheduled run to 'run' and revokes it when the run finishes", async () => {
    const { ScopedTokens } = await import("../src/mcp/scoped-tokens.js");
    const tokens = new ScopedTokens();
    const bin = fakeBinDir("fake-agent", "#!/bin/sh\nexit 0\n");
    let sawToken: string | null = null;
    const minted: string[] = [];
    const launcher = new AgentLauncher(
      {
        ...CTX,
        mintToken: (profile, label) => {
          minted.push(profile);
          return tokens.mint(profile, label);
        },
      },
      specs({
        runArgs: (ctx) => {
          sawToken = ctx.bearerToken;
          return [];
        },
      }),
      { PATH: "" },
      [bin],
    );

    const result = await launcher.runOnce({
      runId: "r1",
      prompt: "do the thing",
      closeGraceMs: 200,
    });
    expect(result.status).toBe("ok");
    expect(minted).toEqual(["run"]);
    expect(sawToken).not.toBe(CTX.bearerToken);
    expect(tokens.resolve(sawToken!)).toBeNull();
    expect(tokens.list()).toHaveLength(0);
    launcher.close();
  });

  it("keeps a model listing out of the workdir a launch writes its credential into", async () => {
    // A listing prepares with no credential. If it prepared into the shared
    // chat workdir it would overwrite a running launch's MCP config with an
    // empty bearer — harmless when every launch wrote the same master token,
    // not harmless now that the credential is per-launch.
    const bin = fakeBinDir(
      "fake-agent",
      `#!/bin/sh
if [ "$1" = "models" ]; then printf 'm1\\tM1\\n'; exit 0; fi
exec /bin/sleep 60
`,
    );
    const prepared: Array<{ dir: string; token: string }> = [];
    const launcher = new AgentLauncher(
      { ...CTX, dataDir: tempDir() },
      specs({
        listModels: { args: ["models"], parse: parseTabbedModels },
        prepare: (ctx, workDir) =>
          prepared.push({ dir: workDir, token: ctx.bearerToken }),
      }),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await launcher.list();
    const listing = prepared.at(-1)!;
    expect(listing.token).toBe("");

    await launcher.start("fake", "m1");
    const launch = prepared.at(-1)!;
    expect(launch.token).not.toBe("");
    expect(launch.dir).not.toBe(listing.dir);
  });

  it("refuses to launch when a preflight says the credential would not be Boxaide's", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(
      CTX,
      specs({ runArgs: () => [], preflight: () => "remove the entry first" }),
      { PATH: "" },
      [bin],
    );
    await expect(launcher.start("fake")).rejects.toThrow("remove the entry first");
    expect(launcher.status().running).toBeNull();
    await expect(
      launcher.runOnce({ runId: "r1", agentId: "fake", prompt: "x" }),
    ).rejects.toThrow("remove the entry first");
    // The reservation is released, or the next run would find no capacity.
    expect(launcher.runCapacity()).toBe(launcher.runLimit());
    launcher.close();
  });

  it("blocks Antigravity when the user's own agy config declares a boxaide server", () => {
    // That entry wins over the one a launch writes, and it carries whatever
    // credential the user pasted into it — so the scope Boxaide minted would
    // not be the scope the agent runs on.
    const spec = KNOWN_AGENTS.find((s) => s.id === "antigravity")!;
    const home = tempDir();
    const configDir = join(home, ".gemini", "config");
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, "mcp_config.json");

    writeFileSync(path, JSON.stringify({ mcpServers: { supabase: {} } }));
    expect(spec.preflight!(CTX, { HOME: home })).toBeNull();

    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { boxaide: { serverUrl: "http://x/mcp" } } }),
    );
    expect(spec.preflight!(CTX, { HOME: home })).toContain("Remove");

    // The name is the user's to choose: /api/agent-connect hands out a URL and
    // an Authorization header with no server name, and agy merges an entry that
    // does not collide rather than replacing it. So a differently-named entry
    // is a second, unscoped connection sitting beside the scoped one.
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { "my-mail": { url: CTX.mcpUrl } } }),
    );
    expect(spec.preflight!(CTX, { HOME: home })).toContain("my-mail");

    // Someone else's local MCP server is not Boxaide's, whatever it is called.
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { other: { url: "http://127.0.0.1:9999/mcp" } },
      }),
    );
    expect(spec.preflight!(CTX, { HOME: home })).toBeNull();

    // No file at all is the normal case and must not block a launch.
    rmSync(path);
    expect(spec.preflight!(CTX, { HOME: home })).toBeNull();
  });

  it("launches every registered CLI, including the ones with no allowlist flag", () => {
    // The boundary is the scoped token the server enforces, so a CLI no longer
    // has to offer --allowedTools to be launchable. This is the assertion that
    // would fail if someone re-disabled one of them for that reason.
    for (const id of ["claude-code", "grok", "antigravity", "opencode", "codex"]) {
      const spec = KNOWN_AGENTS.find((s) => s.id === id)!;
      expect(spec.args !== undefined || spec.drive !== undefined).toBe(true);
      expect(spec.runArgs).toBeDefined();
    }
  });

  it("keeps every agent's credential off its command line", () => {
    // A bearer in argv is readable by every process on the machine and lands
    // in crash reports. Each spec puts it in a config file or the child env
    // instead; this holds all of them to it at once, including the next one.
    const dataDir = tempDir();
    const ctx = {
      mcpUrl: "http://127.0.0.1:8787/mcp",
      bearerToken: "scoped-token-do-not-leak",
      dataDir,
    };
    for (const spec of KNOWN_AGENTS) {
      const workDir = join(dataDir, spec.id);
      mkdirSync(workDir, { recursive: true });
      spec.prepare?.(ctx, workDir, {});
      const argv = [
        ...(spec.args?.(ctx) ?? []),
        ...(spec.runArgs?.(ctx, "do the thing", workDir) ?? []),
      ];
      for (const arg of argv) {
        expect(arg).not.toContain(ctx.bearerToken);
      }
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
    const workDir = join(`${ctx.dataDir}-agents`, "workdir");
    mkdirSync(workDir, { recursive: true });
    claude.prepare!(ctx, workDir, {});
    const path = join(workDir, "claude-mcp.json");
    const args = claudeTurnArgs(ctx, {
      prompt: "what came in?",
      system: "be brief",
      sessionId: null,
    });
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

  it("pre-approves read, draft and send — send is gated by a person, not by the flag", () => {
    const args = claudeTurnArgs(CTX, { prompt: "hi", system: "s", sessionId: null });
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__boxaide__draft_create");
    // Present on purpose. The CLI flag mirrors the scope, and the scope now
    // carries message_send because the server queues that call for the user
    // rather than performing it — see test/mcp-scope.test.ts.
    expect(allowed).toContain("mcp__boxaide__message_send");
    // The agent must not inherit the user's other MCP servers.
    expect(args).toContain("--strict-mcp-config");
  });

  it("keeps the loop's tools off a driven session's allowlist, but not chat_history", () => {
    // Boxaide holds the loop for Claude Code, so its model must not be able to
    // ask for a message: two askers on one channel is a double answer.
    const args = claudeTurnArgs(CTX, { prompt: "hi", system: "s", sessionId: null });
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).not.toContain("chat_await_message");
    expect(allowed).not.toContain("chat_say");
    expect(allowed).not.toContain("chat_activity");
    // chat_history takes no lease, the MCP server does not refuse it for a
    // driven session, and it is how a session whose resume was refused reads
    // back what it no longer remembers.
    expect(allowed).toContain("mcp__boxaide__chat_history");
    // Which the framing has to agree with, or the model will not call it.
    expect(DRIVEN_SYSTEM).toContain("chat_history");

    // A KICKOFF launch still needs them all: there the model runs the loop.
    const grok = KNOWN_AGENTS.find((s) => s.id === "grok")!;
    expect(grok.args!(CTX)).toContain("MCPTool(boxaide__chat_await_message)");

    // A scheduled run gets none of it: there is no conversation to be in.
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const run = claude.runArgs!(CTX, "do the thing", "/tmp/run-dir");
    expect(run[run.indexOf("--allowedTools") + 1]).not.toContain("chat_");
  });

  it("pre-approves the platform tools for the interactive agent too", () => {
    // The Automations UI tells users to ask the in-app agent to create an
    // automation; before this, only the scheduled path knew those tools.
    const args = claudeTurnArgs(CTX, { prompt: "hi", system: "s", sessionId: null });
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__boxaide__automation_create");
    expect(allowed).toContain("mcp__boxaide__crm_contact_upsert");
    expect(allowed).toContain("mcp__boxaide__outbox_queue_draft");

    const grok = KNOWN_AGENTS.find((s) => s.id === "grok")!;
    const grokArgs = grok.args!(CTX);
    expect(grokArgs).toContain("MCPTool(boxaide__automation_create)");
    expect(grokArgs).toContain("MCPTool(boxaide__crm_contact_upsert)");
  });

  it("asks the chat agent for its event stream, and a run for plain text", () => {
    // The stream is how the Agent pane knows a launched CLI is still working
    // while it does its own file and shell work, calling nothing here.
    const grok = KNOWN_AGENTS.find((s) => s.id === "grok")!;
    const grokArgs = grok.args!(CTX);
    expect(grokArgs[grokArgs.indexOf("--output-format") + 1]).toBe(
      "streaming-json",
    );
    expect(grok.readEvent).toBeTypeOf("function");

    // Grok's run still writes plain text; Claude's `-p` prints nothing at all
    // until it exits, so its run asks for the stream and renders it instead.
    expect(grok.runArgs!(CTX, "do the thing", "/tmp/run-dir")).not.toContain("--output-format");
    expect(grok.renderRunLine).toBeUndefined();
  });

  it("streams a Claude run so its log is readable while it works", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const args = claude.runArgs!(CTX, "do the thing", "/tmp/run-dir");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(claude.renderRunLine).toBeTypeOf("function");
    // The run wiring is otherwise untouched.
    expect(args[0]).toBe("-p");
    expect(args).toContain("--strict-mcp-config");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).not.toContain("chat_await_message");
  });

  it("gives Claude its own config home so a run cannot load the user's setup", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    const ctx = { ...CTX, dataDir: tempDir() };
    const workDir = join(`${ctx.dataDir}-agents`, "workdir");
    mkdirSync(workDir, { recursive: true });
    const home = join(`${ctx.dataDir}-agents`, "agent-homes", "claude");
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
    // O_NOFOLLOW: a leftover symlink would throw instead of reading through.
    expect(readRegular(copied)).toBe('{"token":"x"}');

    // And it is refreshed per launch, so a rotated token is not left behind.
    writeFileSync(join(bareParent, ".credentials.json"), '{"token":"y"}');
    claude.prepare!(ctx, workDir, { CLAUDE_CONFIG_DIR: bareParent });
    expect(readRegular(copied)).toBe('{"token":"y"}');
  });

  it("carries only Claude's auth settings across the isolation boundary", () => {
    const claude = KNOWN_AGENTS.find((s) => s.id === "claude-code")!;
    /** Prepares a fresh isolated home against the given parent settings.json. */
    function prepareWith(settings: string | null): string {
      const ctx = { ...CTX, dataDir: tempDir() };
      const workDir = join(`${ctx.dataDir}-agents`, "workdir");
      mkdirSync(workDir, { recursive: true });
      const parent = tempDir();
      if (settings !== null) {
        writeFileSync(join(parent, "settings.json"), settings);
      }
      claude.prepare!(ctx, workDir, { CLAUDE_CONFIG_DIR: parent });
      return join(`${ctx.dataDir}-agents`, "agent-homes", "claude", "settings.json");
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
    expect(grok.runArgs!(CTX, "do the thing", "/tmp/run-dir")).not.toContain(
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
    expect(args.join("\0")).not.toContain(ctx.bearerToken);

    const workDir = join(`${ctx.dataDir}-agents`, "workdir");
    mkdirSync(workDir, { recursive: true });
    grok!.prepare!(ctx, workDir, { PATH: "/usr/bin" });
    const env = grok!.childEnv!(ctx, workDir);
    expect(env.BOXAIDE_TOKEN).toBe(ctx.bearerToken);
    // The home lives in the launch's own workdir, so overlapping runs never
    // share one (their trusted-folder lists would fight).
    expect(env.GROK_HOME).toBe(join(workDir, "grok-home"));
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
      {
        mcpUrl: "http://127.0.0.1:9/mcp",
        bearerToken: "secret-token-xyz",
        dataDir,
        // This is about the config grok's prepare writes, not about
        // confinement; a workspace launch is refused off macOS by design.
        access: "full" as const,
      },
      [grok],
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    const running = await launcher.start("grok");
    expect(running.id).toBe("grok");
    const home = join(`${dataDir}-agents`, "workdir", "grok-home");
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
    const result = await launcher.runOnce({ runId: "r1", prompt: "do the thing" });
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
      runId: "r1",
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
      runId: "r1",
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
      runId: "r1",
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
      runId: "r1",
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
      runId: "r1",
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
      runId: "r1",
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
      runId: "r1",
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
      runId: "r1",
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
    for (const id of ["antigravity", "opencode", "codex", "grok"]) {
      expect(body.agents.find((a: { id: string }) => a.id === id)?.supported).toBe(
        true,
      );
    }

    const unknown = await runtime.app.request("/api/agents/nope/start", {
      method: "POST",
      headers: auth,
    });
    expect(unknown.status).toBe(404);

    // Every registered agent now has a launch recipe, so there is no
    // "registered but unlaunchable" case left to assert here. What the route
    // still refuses is an id that is not in the registry at all, above.

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

/**
 * Getting a signed-out Claude Code back on its feet, from the two ends the
 * server owns: the credential the launch copied, and the terminal the user has
 * to finish the login in.
 */
describe("claude sign-in", () => {
  function homes(): { parentHome: string; home: string } {
    const root = tempDir();
    const parentHome = join(root, "parent");
    const home = join(root, "agent-home");
    mkdirSync(parentHome, { recursive: true });
    mkdirSync(home, { recursive: true });
    return { parentHome, home };
  }

  function credential(dir: string, content: string, mtime: number): string {
    const path = join(dir, ".credentials.json");
    writeFileSync(path, content);
    utimesSync(path, mtime / 1000, mtime / 1000);
    return path;
  }

  it("drops the copied credential and takes the newer one from the user's home", () => {
    const { parentHome, home } = homes();
    credential(home, '{"stale":true}', Date.now() - 60_000);
    credential(parentHome, '{"fresh":true}', Date.now());

    expect(claudeHealCredentials(parentHome, home)).toBe(true);
    expect(readFileSync(join(home, ".credentials.json"), "utf8")).toBe('{"fresh":true}');
    // The user's own file is what isolation exists to protect; a repair must
    // read it and nothing more.
    expect(readFileSync(join(parentHome, ".credentials.json"), "utf8")).toBe(
      '{"fresh":true}',
    );
  });

  it("leaves nothing behind when the copy is the only file there is", () => {
    // The macOS case this was written for: the real login is in the keychain,
    // and the copied file is an expired leftover shadowing it. Deleting it is
    // the whole repair — the CLI then finds the keychain by itself.
    const { parentHome, home } = homes();
    credential(home, '{"stale":true}', Date.now() - 60_000);

    expect(claudeHealCredentials(parentHome, home)).toBe(true);
    expect(existsSync(join(home, ".credentials.json"))).toBe(false);
  });

  it("does not overwrite a copy that is newer than the user's own file", () => {
    // A login that landed after this launch started wrote the newer file. Going
    // back to the parent's older one would undo the fix mid-run.
    const { parentHome, home } = homes();
    credential(parentHome, '{"older":true}', Date.now() - 60_000);
    credential(home, '{"newer":true}', Date.now());

    expect(claudeHealCredentials(parentHome, home)).toBe(true);
    expect(existsSync(join(home, ".credentials.json"))).toBe(false);
  });

  it("says nothing moved when there is nothing to move", () => {
    // False is the driver's signal not to spend another process: a retry would
    // meet the identical credential.
    const { parentHome, home } = homes();
    expect(claudeHealCredentials(parentHome, home)).toBe(false);
  });

  it("does not repair over a login the home made for itself", () => {
    // A `claude /login` run inside the isolated home records the account in
    // that home's .claude.json; on macOS the token itself sits in a keychain
    // entry keyed to the directory, invisible to this file. Copying the user's
    // terminal credential in would shadow that working login with a leftover.
    const { parentHome, home } = homes();
    writeFileSync(join(home, ".claude.json"), '{"oauthAccount":{"emailAddress":"a@b.c"}}');
    credential(parentHome, '{"leftover":true}', Date.now());

    expect(claudeHealCredentials(parentHome, home)).toBe(false);
    expect(existsSync(join(home, ".credentials.json"))).toBe(false);
  });

  it("keeps prepare's credential copy away from a home that owns its login", () => {
    const { parentHome, home } = homes();
    credential(parentHome, '{"leftover":true}', Date.now());

    // Owning nothing, the copy still happens — the Linux/file path.
    claudeCopyCredentials(parentHome, home);
    expect(existsSync(join(home, ".credentials.json"))).toBe(true);
    rmSync(join(home, ".credentials.json"));

    // Owning a login, it must not.
    writeFileSync(join(home, ".claude.json"), '{"oauthAccount":{"emailAddress":"a@b.c"}}');
    claudeCopyCredentials(parentHome, home);
    expect(existsSync(join(home, ".credentials.json"))).toBe(false);

    // A signed-out record — /logout writes null — reopens the copy path.
    writeFileSync(join(home, ".claude.json"), '{"oauthAccount":null}');
    claudeCopyCredentials(parentHome, home);
    expect(existsSync(join(home, ".credentials.json"))).toBe(true);
  });

  it("names the same binary a launch would spawn, and the model it last used", async () => {
    const bin = fakeBinDir("fake-agent");
    const launcher = new AgentLauncher(
      CTX,
      [...specs(), { id: "ghost", label: "Ghost", bin: "not-installed" }],
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    expect(launcher.binFor("fake")).toBe(join(bin, "fake-agent"));
    expect(launcher.binFor("ghost")).toBeNull();
    expect(launcher.binFor("nobody")).toBeNull();

    expect(launcher.lastModelFor("fake")).toBeNull();
    await launcher.start("fake");
    launcher.stop();
    // Null is an answer here — the CLI's own default — and it survives the exit
    // so a relaunch nobody pressed Start for restores what was picked.
    expect(launcher.lastModelFor("fake")).toBeNull();
  });

  it("quotes the login command through both the shell and the AppleScript", () => {
    // An ordinary install path with a space in it. Unquoted, Terminal runs
    // `/Users/Ada` and the user sees a shell error instead of a login.
    const script = claudeLoginScript(
      "/Users/Ada Byron/.local/bin/claude",
      "/Users/Ada Byron/.sley-agents/agent-homes/claude",
    );
    expect(script).toContain(
      `do script "CLAUDE_CONFIG_DIR='/Users/Ada Byron/.sley-agents/agent-homes/claude' '/Users/Ada Byron/.local/bin/claude' /login"`,
    );
    expect(script).toContain('tell application "Terminal"');
    expect(script).toContain("activate");
    // A quote in the path would otherwise end the AppleScript string early and
    // run whatever followed it.
    expect(claudeLoginScript(`/tmp/a"b/claude`, "/tmp/home")).toContain(`a\\"b`);
  });

  it("signs the login into the isolated home, not the user's own", () => {
    // The macOS keychain keys the CLI's login to its config directory. A login
    // without CLAUDE_CONFIG_DIR lands where no launch looks, and the button
    // "works" forever without fixing anything.
    const script = claudeLoginScript("/usr/local/bin/claude", "/data-agents/agent-homes/claude");
    expect(script).toContain("CLAUDE_CONFIG_DIR='/data-agents/agent-homes/claude'");
  });

  it("restarts the agent when a login lands, on the model it last used", async () => {
    const dir = tempDir();
    const credentials = join(dir, ".credentials.json");
    const record = join(dir, ".claude.json");
    writeFileSync(record, "{}");
    const started: Array<string | undefined> = [];
    const cancel = watchForClaudeSignIn(
      {
        chatBusy: () => false,
        lastModelFor: () => "claude-sonnet-4-5",
        start: (id, model) => {
          started.push(model);
          expect(id).toBe("claude-code");
          return Promise.resolve({});
        },
      },
      [credentials, record],
      { pollMs: 10, windowMs: 5_000 },
    );
    cleanups.push(cancel);

    // The file did not exist when the watch started: a first sign-in is exactly
    // the case where it does not.
    writeFileSync(credentials, '{"fresh":true}');
    await until(() => started.length === 1);
    expect(started).toEqual(["claude-sonnet-4-5"]);

    // One landing, one relaunch: the watch stops itself rather than starting an
    // agent again every time the CLI refreshes a token.
    writeFileSync(credentials, '{"fresher":true}');
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toHaveLength(1);
  });

  it("does not start a second agent over one the user started themselves", async () => {
    const dir = tempDir();
    const credentials = join(dir, ".credentials.json");
    let starts = 0;
    const cancel = watchForClaudeSignIn(
      {
        chatBusy: () => true,
        lastModelFor: () => null,
        start: () => {
          starts += 1;
          return Promise.resolve({});
        },
      },
      [credentials],
      { pollMs: 10, windowMs: 5_000 },
    );
    cleanups.push(cancel);

    writeFileSync(credentials, "{}");
    await new Promise((r) => setTimeout(r, 60));
    expect(starts).toBe(0);
  });

  it("gives up on a login that never lands, and cancels cleanly", async () => {
    const dir = tempDir();
    let starts = 0;
    const cancel = watchForClaudeSignIn(
      {
        chatBusy: () => false,
        lastModelFor: () => null,
        start: () => {
          starts += 1;
          return Promise.resolve({});
        },
      },
      [join(dir, ".credentials.json")],
      { pollMs: 10, windowMs: 20 },
    );
    // The window passes with nothing written: the terminal was abandoned, and
    // nothing may be started an hour later out of nowhere.
    await new Promise((r) => setTimeout(r, 80));
    expect(starts).toBe(0);
    // Cancelling an already-finished watch is a no-op, which is what lets the
    // route cancel unconditionally when the button is pressed twice.
    cancel();
    cancel();
  });
});

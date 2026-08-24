/**
 * The wiring, not the module.
 *
 * test/log.test.ts proves that src/log.ts rotates and redacts. This file
 * proves the thing that was actually missing: that an agent child dying takes
 * a line with it to disk, so a restart no longer erases the only record there
 * was. The incident it stands for is an `agy` that exited 1 with empty stderr
 * and left nothing behind but an in-memory `lastExit`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLauncher, type AgentSpec } from "../src/agent/launcher.js";
import { configureLog } from "../src/log.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  configureLog({ dataDir: null });
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "boxaide-log-wiring-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
    // The launcher hangs the agent tree off `<dataDir>-agents`.
    rmSync(`${dir}-agents`, { recursive: true, force: true });
  });
  return dir;
}

/** A stand-in agent binary on a PATH that holds nothing else. */
function fakeBinDir(script: string): string {
  const dir = join(tempDir(), "bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fake-agent");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

function specs(): AgentSpec[] {
  return [{ id: "fake", label: "Fake Agent", bin: "fake-agent", args: () => [] }];
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("what a dead agent leaves on disk", () => {
  it("writes the launch and the exit, with the stderr tail redacted", async () => {
    const dataDir = tempDir();
    // Exactly the shape of the failure that started this: a non-zero exit, and
    // stderr that carries the credential the CLI was refused for.
    const bin = fakeBinDir(
      '#!/bin/sh\necho "auth failed: api_key=sk-live-0123456789abcdef" 1>&2\nexit 1\n',
    );
    const launcher = new AgentLauncher(
      { mcpUrl: "http://127.0.0.1:0/mcp", bearerToken: "t", dataDir, access: "full" },
      specs(),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await launcher.start("fake");
    await until(() => launcher.status().running === null);

    const written = readFileSync(join(dataDir, "logs", "boxaide.log"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const launched = written.find((line) => line.msg === "chat launch");
    expect(launched).toMatchObject({ scope: "agent.launcher", agent: "fake", driven: false });
    expect(typeof launched?.pid).toBe("number");

    const exited = written.find((line) => line.msg === "chat exit");
    expect(exited).toMatchObject({
      level: "error",
      scope: "agent.launcher",
      agent: "fake",
      code: 1,
      reason: "exited",
      authRequired: false,
    });
    // The tail is what says why, so it has to be there.
    expect(String(exited?.stderrTail)).toContain("auth failed");
    // And it has to be there without the key the CLI printed.
    expect(String(exited?.stderrTail)).not.toContain("sk-live-0123456789abcdef");
  });

  it("writes nothing for a :memory: install", async () => {
    const dataDir = tempDir();
    const bin = fakeBinDir("#!/bin/sh\nexit 0\n");
    const launcher = new AgentLauncher(
      {
        mcpUrl: "http://127.0.0.1:0/mcp",
        bearerToken: "t",
        dataDir: ":memory:",
        access: "full",
      },
      specs(),
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());
    await launcher.start("fake");
    await until(() => launcher.status().running === null);
    // Nothing was pointed here, and nothing wrote here.
    expect(() => readFileSync(join(dataDir, "logs", "boxaide.log"), "utf8")).toThrow();
  });
});

/**
 * Automations: store, scheduler serialization, tools, and the launcher's
 * one-shot path.
 *
 * The scheduler is always driven with a fake launcher. Spawning a real agent
 * CLI here would bill the user's account and hang the suite; the only real
 * processes in this file are throwaway shell scripts (same rule as
 * test/agent-launcher.test.ts).
 */
import Database from "better-sqlite3";
import type { Hono } from "hono";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentLauncher,
  AUTOMATION_RUN_PREAMBLE,
  LaunchError,
  runPreapprovedToolNames,
  type AgentSpec,
  type OneShotResult,
} from "../src/agent/launcher.js";
import { AutomationScheduler, type OneShotLauncher } from "../src/automation/scheduler.js";
import { AutomationStore, nextRunAfter, RUN_STALE_MS } from "../src/automation/store.js";
import { AUTOMATION_TOOLS, dispatchAutomationTool } from "../src/automation/tools.js";
import type { Platform } from "../src/platform.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const KEY = randomBytes(32);

function newStore(): AutomationStore {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  return new AutomationStore(db, KEY);
}

/**
 * Two stores over ONE database file: the only way to test the cross-process
 * lock. `:memory:` cannot be shared between connections, so a second store
 * over `:memory:` would be a second empty database and prove nothing.
 */
function newSharedStores(): [AutomationStore, AutomationStore] {
  const path = join(tempDir(), "automations.db");
  return [openStore(path), openStore(path)];
}

function openStore(path: string): AutomationStore {
  const db = new Database(path);
  cleanups.push(() => db.close());
  return new AutomationStore(db, KEY);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mailmux-automation-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeBinDir(name: string, script: string): string {
  const dir = join(tempDir(), "bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

describe("AutomationStore", () => {
  it("creates, reads, updates and deletes", () => {
    const store = newStore();
    const created = store.create({
      name: "Morning triage",
      cron: "0 8 * * *",
      prompt: "Triage the inbox.",
    });
    expect(created.id).toBeTruthy();
    expect(created.enabled).toBe(true);
    expect(created.lastRunAt).toBeNull();
    expect(store.get(created.id)?.name).toBe("Morning triage");
    expect(store.list()).toHaveLength(1);

    const updated = store.update(created.id, { prompt: "Triage and label." });
    expect(updated?.prompt).toBe("Triage and label.");
    expect(store.get(created.id)?.prompt).toBe("Triage and label.");
    expect(store.update("nope", { prompt: "x" })).toBeNull();

    expect(store.delete(created.id)).toBe(true);
    expect(store.delete(created.id)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("rejects a duplicate name with a readable error", () => {
    const store = newStore();
    store.create({ name: "Daily", cron: "0 8 * * *", prompt: "p" });
    expect(() =>
      store.create({ name: "Daily", cron: "0 9 * * *", prompt: "p" }),
    ).toThrowError(/already exists/);
  });

  it("validates cron on create and on update", () => {
    const store = newStore();
    expect(() =>
      store.create({ name: "bad", cron: "not a cron", prompt: "p" }),
    ).toThrowError(/invalid cron expression/);
    // A 6-field expression is seconds-first: an every-second agent spawn.
    expect(() =>
      store.create({ name: "bad", cron: "* * * * * *", prompt: "p" }),
    ).toThrowError(/expected 5 fields/);
    expect(() =>
      store.create({ name: "bad", cron: "99 * * * *", prompt: "p" }),
    ).toThrowError(/invalid cron expression/);
    // Nothing was written by a rejected create.
    expect(store.list()).toEqual([]);

    const ok = store.create({ name: "ok", cron: "0 8 * * *", prompt: "p" });
    expect(() => store.update(ok.id, { cron: "0 61 * * *" })).toThrowError(
      /invalid cron/,
    );
    expect(store.get(ok.id)?.cron).toBe("0 8 * * *");
  });

  it("computes next_run_at from the cron, and clears it when disabled", () => {
    const store = newStore();
    const now = new Date("2026-08-13T07:00:00Z");
    const a = store.create({
      name: "Hourly",
      cron: "0 * * * *",
      prompt: "p",
      now,
    });
    expect(a.nextRunAt).toBe(nextRunAfter("0 * * * *", now).toISOString());
    expect(new Date(a.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());

    const paused = store.update(a.id, { enabled: false, now });
    expect(paused?.nextRunAt).toBeNull();

    // Re-enabling schedules from now, never from the stale stored time.
    const later = new Date("2026-08-20T07:30:00Z");
    const resumed = store.update(a.id, { enabled: true, now: later });
    expect(new Date(resumed!.nextRunAt!).getTime()).toBeGreaterThan(
      later.getTime(),
    );
  });

  it("keeps the current prompt when a patch carries an empty one", () => {
    const store = newStore();
    const a = store.create({ name: "n", cron: "0 8 * * *", prompt: "Triage." });
    expect(store.update(a.id, { prompt: "  " })?.prompt).toBe("Triage.");
    expect(store.get(a.id)?.prompt).toBe("Triage.");
  });

  it("finds only enabled, due automations", () => {
    const store = newStore();
    const past = new Date("2026-08-13T07:00:00Z");
    const due = store.create({ name: "due", cron: "0 * * * *", prompt: "p", now: past });
    store.create({ name: "later", cron: "0 8 * * *", prompt: "p", now: new Date() });
    const off = store.create({ name: "off", cron: "0 * * * *", prompt: "p", now: past });
    store.update(off.id, { enabled: false });

    const found = store.due(new Date("2026-08-13T09:00:00Z"));
    expect(found.map((a) => a.id)).toEqual([due.id]);
  });

  it("records runs, encrypts the log at rest, and returns a 4 KiB tail", () => {
    const store = newStore();
    const a = store.create({ name: "n", cron: "0 8 * * *", prompt: "p" });
    const run = store.startRun(a.id);
    expect(store.listRuns({ automationId: a.id })[0].status).toBe("running");

    const log = `head-marker${"x".repeat(9_000)}tail-marker`;
    store.finishRun(run.id, { status: "ok", exitCode: 0, log });

    const [saved] = store.listRuns({ automationId: a.id });
    expect(saved.status).toBe("ok");
    expect(saved.exitCode).toBe(0);
    expect(saved.finishedAt).toBeTruthy();
    expect(saved.log).toHaveLength(4 * 1024);
    expect(saved.log.endsWith("tail-marker")).toBe(true);
    expect(saved.log).not.toContain("head-marker");

    const raw = store.db
      .prepare(`SELECT log_enc FROM automation_runs WHERE id = ?`)
      .get(run.id) as { log_enc: string };
    expect(raw.log_enc).not.toContain("tail-marker");

    // Cross-automation listing and the limit clamp.
    const b = store.create({ name: "m", cron: "0 8 * * *", prompt: "p" });
    store.finishRun(store.startRun(b.id).id, { status: "error", exitCode: 2 });
    expect(store.listRuns({}).length).toBe(2);
    expect(store.listRuns({ automationId: b.id })[0].exitCode).toBe(2);
    expect(store.listRuns({ automationId: b.id })[0].log).toBe("");

    // Deleting the automation takes its runs with it.
    store.delete(b.id);
    expect(store.listRuns({ automationId: b.id })).toEqual([]);
  });

  it("stamps last_run_at and the recomputed next_run_at", () => {
    const store = newStore();
    const a = store.create({ name: "n", cron: "0 * * * *", prompt: "p" });
    const at = new Date("2026-08-13T09:05:00Z");
    store.noteRun(a.id, at, nextRunAfter("0 * * * *", at).toISOString());
    const after = store.get(a.id)!;
    expect(after.lastRunAt).toBe(at.toISOString());
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(at.getTime());
  });

  it("refuses a claim while another process holds a fresh run", () => {
    // Two stores, one file = `boxaide serve` and a stdio `boxaide mcp`, each
    // with its own in-process FIFO. Only the DB lock sees both.
    const [serve, mcp] = newSharedStores();
    const a = serve.create({ name: "a", cron: "0 8 * * *", prompt: "p" });
    const b = serve.create({ name: "b", cron: "0 8 * * *", prompt: "p" });

    const held = serve.claimRun(a.id);
    expect(held).not.toBeNull();
    // Same automation and a different one: one run at a time, globally.
    expect(mcp.claimRun(a.id)).toBeNull();
    expect(mcp.claimRun(b.id)).toBeNull();
    // The young row is untouched — the other process is really using it.
    expect(mcp.listRuns({})).toHaveLength(1);
    expect(mcp.listRuns({})[0].status).toBe("running");

    serve.finishRun(held!.id, { status: "ok", exitCode: 0 });
    expect(mcp.claimRun(b.id)).not.toBeNull();
  });

  it("sweeps a stale running row to killed, which frees the next claim", () => {
    const [crashed, restarted] = newSharedStores();
    const a = crashed.create({ name: "a", cron: "0 8 * * *", prompt: "p" });
    const longAgo = new Date(Date.now() - RUN_STALE_MS - 60_000);
    // The process that owned this row never came back to finish it.
    const abandoned = crashed.claimRun(a.id, { now: longAgo })!;
    expect(abandoned).not.toBeNull();

    const claimed = restarted.claimRun(a.id);
    expect(claimed).not.toBeNull();

    const swept = restarted
      .listRuns({ automationId: a.id })
      .find((run) => run.id === abandoned.id)!;
    expect(swept.status).toBe("killed");
    expect(swept.finishedAt).toBeTruthy();
    expect(swept.log).toContain("marked killed");
  });
});

/** Records every run and can hold one open, so overlap is observable. */
class FakeLauncher implements OneShotLauncher {
  calls: { agentId?: string | null; prompt: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  chatRunning = false;
  killed = 0;
  result: OneShotResult = { status: "ok", exitCode: 0, log: "ran" };
  throwWith: Error | null = null;
  private release: (() => void) | null = null;
  private held: Promise<void> | null = null;

  /** Makes the next runs block until releaseAll(). */
  hold(): void {
    this.held = new Promise<void>((r) => {
      this.release = r;
    });
  }

  releaseAll(): void {
    this.release?.();
    this.held = null;
    this.release = null;
  }

  busy(): boolean {
    return this.chatRunning || this.inFlight > 0;
  }

  async runOnce(opts: { agentId?: string | null; prompt: string }): Promise<OneShotResult> {
    this.calls.push(opts);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.held) await this.held;
      if (this.throwWith) throw this.throwWith;
      return this.result;
    } finally {
      this.inFlight--;
    }
  }

  killRun(): void {
    this.killed++;
    this.releaseAll();
  }
}

describe("AutomationScheduler", () => {
  const past = new Date("2026-08-13T07:00:00Z");
  const now = new Date("2026-08-13T09:00:00Z");

  it("runs due automations, one at a time, and logs each run", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(store, launcher);
    const a = store.create({ name: "a", cron: "0 * * * *", prompt: "do a", now: past });
    const b = store.create({ name: "b", cron: "0 * * * *", prompt: "do b", now: past });

    await scheduler.tick(now);

    expect(launcher.maxInFlight).toBe(1);
    expect(launcher.calls.map((c) => c.prompt)).toEqual(["do a", "do b"]);
    for (const id of [a.id, b.id]) {
      const [run] = store.listRuns({ automationId: id });
      expect(run.status).toBe("ok");
      expect(run.exitCode).toBe(0);
      expect(run.log).toBe("ran");
      // last/next run stamped, next one in the future.
      const saved = store.get(id)!;
      expect(saved.lastRunAt).toBeTruthy();
      expect(new Date(saved.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    }
    expect(scheduler.state()).toEqual({ active: null, queued: [] });
  });

  it("passes the automation's agent id through to the launcher", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(store, launcher);
    store.create({
      name: "a",
      cron: "0 * * * *",
      prompt: "p",
      agentId: "claude-code",
      now: past,
    });
    await scheduler.tick(now);
    expect(launcher.calls[0].agentId).toBe("claude-code");
  });

  it("waits behind an interactive chat agent instead of dropping the run", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    launcher.chatRunning = true;
    const scheduler = new AutomationScheduler(store, launcher);
    const a = store.create({ name: "a", cron: "0 * * * *", prompt: "p", now: past });

    await scheduler.tick(now);
    expect(launcher.calls).toEqual([]);
    expect(store.listRuns({ automationId: a.id })).toEqual([]);
    expect(scheduler.state().queued).toEqual([a.id]);

    launcher.chatRunning = false;
    await scheduler.tick(now);
    expect(launcher.calls).toHaveLength(1);
  });

  it("never queues the same automation twice while it is still running", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(store, launcher);
    store.create({ name: "a", cron: "* * * * *", prompt: "p", now: past });

    launcher.hold();
    const first = scheduler.tick(now);
    await new Promise((r) => setTimeout(r, 10));
    // The row is still due (next_run_at only moves when the run finishes), so
    // a second tick sees it again and must not start a second run. Not awaited
    // here for the same reason the 30s timer does not await it: a tick that
    // joins an in-flight drain resolves only when that drain is done.
    const second = scheduler.tick(now);
    await new Promise((r) => setTimeout(r, 10));
    expect(launcher.inFlight).toBe(1);
    expect(scheduler.state().queued).toEqual([]);

    launcher.releaseAll();
    await Promise.all([first, second]);
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.maxInFlight).toBe(1);
  });

  it("records a refused or crashed run as an error instead of losing it", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    launcher.throwWith = new Error("no agent CLI is installed to run automations");
    const scheduler = new AutomationScheduler(store, launcher);
    const a = store.create({ name: "a", cron: "0 * * * *", prompt: "p", now: past });

    await scheduler.tick(now);
    const [run] = store.listRuns({ automationId: a.id });
    expect(run.status).toBe("error");
    expect(run.exitCode).toBeNull();
    expect(run.log).toContain("no agent CLI is installed");
  });

  it("reports a killed run with its status", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    launcher.result = { status: "killed", exitCode: null, log: "timed out" };
    const scheduler = new AutomationScheduler(store, launcher);
    const a = store.create({ name: "a", cron: "0 * * * *", prompt: "p", now: past });

    await scheduler.tick(now);
    const [run] = store.listRuns({ automationId: a.id });
    expect(run.status).toBe("killed");
    expect(run.log).toBe("timed out");
  });

  it("skips an automation disabled or deleted while it sat in the queue", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(store, launcher);
    const a = store.create({ name: "a", cron: "0 * * * *", prompt: "p", now: past });
    const b = store.create({ name: "b", cron: "0 * * * *", prompt: "p", now: past });
    launcher.chatRunning = true;
    await scheduler.tick(now);
    expect(scheduler.state().queued).toEqual([a.id, b.id]);

    store.update(a.id, { enabled: false });
    store.delete(b.id);
    launcher.chatRunning = false;
    await scheduler.tick(now);

    expect(launcher.calls).toEqual([]);
    expect(store.listRuns({}).length).toBe(0);
  });

  it("leaves next_run_at null for an automation disabled during its run", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(store, launcher);
    const a = store.create({ name: "a", cron: "0 * * * *", prompt: "p", now: past });

    launcher.hold();
    const ticking = scheduler.tick(now);
    await until(() => launcher.inFlight === 1);
    // Paused while the run is in flight: finishing the run must not put a
    // future next_run_at back on a disabled row.
    store.update(a.id, { enabled: false });
    launcher.releaseAll();
    await ticking;

    const after = store.get(a.id)!;
    expect(after.lastRunAt).toBeTruthy();
    expect(after.nextRunAt).toBeNull();
  });

  it("runNow queues off-schedule, and stop kills the run in flight", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(store, launcher);
    // Far-future cron: this only ever runs because runNow asked it to.
    const a = store.create({ name: "a", cron: "0 4 1 1 *", prompt: "p" });

    await scheduler.runNow(a.id);
    expect(launcher.calls).toHaveLength(1);
    expect(store.listRuns({ automationId: a.id })[0].status).toBe("ok");

    scheduler.stop();
    expect(launcher.killed).toBe(1);
  });

  it("keeps a due job queued while another process holds the run lock", async () => {
    const [serve, other] = newSharedStores();
    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(serve, launcher);
    const a = serve.create({ name: "a", cron: "0 * * * *", prompt: "p", now: past });
    // The other process starts its run first; this scheduler's FIFO cannot see it.
    const held = other.claimRun(a.id)!;

    await scheduler.tick(now);
    expect(launcher.calls).toEqual([]);
    expect(scheduler.state()).toEqual({ active: null, queued: [a.id] });

    other.finishRun(held.id, { status: "ok", exitCode: 0 });
    await scheduler.tick(now);
    expect(launcher.calls).toHaveLength(1);
    expect(scheduler.state().queued).toEqual([]);
  });

  it("sweeps a run abandoned by a crashed process when it constructs", async () => {
    const [crashed, restarted] = newSharedStores();
    const a = crashed.create({ name: "a", cron: "0 * * * *", prompt: "p", now: past });
    const abandoned = crashed.claimRun(a.id, {
      now: new Date(Date.now() - RUN_STALE_MS - 60_000),
    })!;

    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(restarted, launcher);
    const swept = restarted.listRuns({ automationId: a.id })[0];
    expect(swept.id).toBe(abandoned.id);
    expect(swept.status).toBe("killed");

    // And the freed lock lets the next scheduled run through.
    await scheduler.tick(now);
    expect(launcher.calls).toHaveLength(1);
  });
});

/** Only the platform fields the automation tools touch. */
function fakePlatform(store: AutomationStore, scheduler: AutomationScheduler): Platform {
  return { automationStore: store, scheduler } as unknown as Platform;
}

describe("automation tools", () => {
  it("exposes exactly the six spec tools, and teaches prompt writing", () => {
    expect(AUTOMATION_TOOLS.map((t) => t.name)).toEqual([
      "automation_create",
      "automation_update",
      "automation_delete",
      "automations_list",
      "automation_run_now",
      "automation_runs_list",
    ]);
    const create = AUTOMATION_TOOLS.find((t) => t.name === "automation_create")!;
    expect(create.description).toMatch(/NO memory of this conversation/);
    expect(create.description).toMatch(/cannot send email/);
    // No approve/send tool ever leaks in here.
    expect(AUTOMATION_TOOLS.map((t) => t.name).join(" ")).not.toContain("send");
  });

  it("dispatches the full lifecycle", async () => {
    const store = newStore();
    const launcher = new FakeLauncher();
    const scheduler = new AutomationScheduler(store, launcher);
    const platform = fakePlatform(store, scheduler);

    const created = (await dispatchAutomationTool(platform, "automation_create", {
      name: "Weekly digest",
      cron: "0 9 * * 1",
      prompt: "Summarise last week.",
    })) as { automation: { id: string; nextRunAt: string } };
    expect(created.automation.nextRunAt).toBeTruthy();

    const listed = (await dispatchAutomationTool(platform, "automations_list", {})) as {
      automations: unknown[];
    };
    expect(listed.automations).toHaveLength(1);

    const updated = (await dispatchAutomationTool(platform, "automation_update", {
      automationId: created.automation.id,
      enabled: false,
    })) as { automation: { enabled: boolean } };
    expect(updated.automation.enabled).toBe(false);

    await dispatchAutomationTool(platform, "automation_update", {
      automationId: created.automation.id,
      enabled: true,
    });
    await dispatchAutomationTool(platform, "automation_run_now", {
      automationId: created.automation.id,
    });
    // run_now returns as soon as it is queued; let the drain settle.
    await new Promise((r) => setTimeout(r, 20));
    const runs = (await dispatchAutomationTool(platform, "automation_runs_list", {
      automationId: created.automation.id,
    })) as { runs: { status: string; log: string }[] };
    expect(runs.runs[0].status).toBe("ok");
    expect(runs.runs[0].log).toBe("ran");

    expect(
      await dispatchAutomationTool(platform, "automation_delete", {
        automationId: created.automation.id,
      }),
    ).toEqual({ deleted: true });
  });

  it("reports bad input as tool errors", async () => {
    const store = newStore();
    const platform = fakePlatform(store, new AutomationScheduler(store, new FakeLauncher()));
    await expect(
      dispatchAutomationTool(platform, "automation_create", { name: "x", cron: "0 8 * * *" }),
    ).rejects.toThrow(/prompt is required/);
    await expect(
      dispatchAutomationTool(platform, "automation_create", {
        name: "x",
        cron: "nope",
        prompt: "p",
      }),
    ).rejects.toThrow(/invalid cron/);
    await expect(
      dispatchAutomationTool(platform, "automation_update", { automationId: "ghost" }),
    ).rejects.toThrow(/unknown automation/);
    await expect(
      dispatchAutomationTool(platform, "automation_run_now", { automationId: "ghost" }),
    ).rejects.toThrow(/unknown automation/);
    await expect(
      dispatchAutomationTool(platform, "nope", {}),
    ).rejects.toThrow(/unknown tool/);
  });
});

describe("AgentLauncher.runOnce", () => {
  const CTX = { mcpUrl: "http://127.0.0.1:0/mcp", bearerToken: "t", dataDir: ":memory:" };

  function runSpecs(script: string, onPrompt?: (p: string) => void): {
    specs: AgentSpec[];
    bin: string;
  } {
    const bin = fakeBinDir("fake-agent", script);
    return {
      bin,
      specs: [
        {
          id: "fake",
          label: "Fake Agent",
          bin: "fake-agent",
          args: () => [],
          runArgs: (_ctx, prompt) => {
            onPrompt?.(prompt);
            return [];
          },
        },
      ],
    };
  }

  it("captures stdout and stderr, and prepends the run preamble", async () => {
    let prompt = "";
    const { specs, bin } = runSpecs(
      "#!/bin/sh\necho 'read 3 messages'\necho 'a warning' >&2\nexit 0\n",
      (p) => {
        prompt = p;
      },
    );
    const launcher = new AgentLauncher(CTX, specs, { PATH: bin });
    cleanups.push(() => launcher.close());

    const result = await launcher.runOnce({ prompt: "Triage the inbox." });
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain("read 3 messages");
    expect(result.log).toContain("a warning");
    expect(prompt.startsWith(AUTOMATION_RUN_PREAMBLE)).toBe(true);
    expect(prompt.endsWith("Triage the inbox.")).toBe(true);
    expect(launcher.busy()).toBe(false);
    // A run must not be mistaken for the chat agent by /api/agents.
    expect(launcher.status().running).toBeNull();
  });

  it("reports a non-zero exit as an error run", async () => {
    const { specs, bin } = runSpecs("#!/bin/sh\necho 'boom' >&2\nexit 4\n");
    const launcher = new AgentLauncher(CTX, specs, { PATH: bin });
    cleanups.push(() => launcher.close());

    const result = await launcher.runOnce({ prompt: "p" });
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(4);
    expect(result.log).toContain("boom");
  });

  it("SIGKILLs a run that outlives its timeout", async () => {
    // Builtins only: the launcher rebuilds the child PATH from the test's
    // fake dir plus well-known CLI dirs, none of which is /usr/bin — an
    // external `sleep` exits 127 on CI runners before the timeout fires,
    // and the run reads 'error' instead of 'killed'.
    const { specs, bin } = runSpecs("#!/bin/sh\nwhile :; do :; done\n");
    const launcher = new AgentLauncher(CTX, specs, { PATH: bin });
    cleanups.push(() => launcher.close());

    const result = await launcher.runOnce({ prompt: "p", timeoutMs: 100 });
    expect(result.status).toBe("killed");
    expect(result.exitCode).toBeNull();
    expect(launcher.busy()).toBe(false);
  });

  it("refuses a run while the chat agent holds the slot, and the reverse", async () => {
    // Builtins only — same reason as the timeout test above.
    const { specs, bin } = runSpecs("#!/bin/sh\nwhile :; do :; done\n");
    const launcher = new AgentLauncher(CTX, specs, { PATH: bin });
    cleanups.push(() => launcher.close());

    launcher.start("fake");
    expect(launcher.busy()).toBe(true);
    await expect(launcher.runOnce({ prompt: "p" })).rejects.toThrowError(LaunchError);
    launcher.stop();
    await until(() => launcher.status().running === null);

    const pending = launcher.runOnce({ prompt: "p", timeoutMs: 5_000 });
    await until(() => launcher.busy());
    expect(() => launcher.start("fake")).toThrowError(/automation run is in progress/);
    launcher.killRun();
    expect((await pending).status).toBe("killed");
  });

  it("rejects an unknown or unrunnable agent id, and finds one when none is named", async () => {
    const { specs, bin } = runSpecs("#!/bin/sh\nexit 0\n");
    const launcher = new AgentLauncher(
      CTX,
      [...specs, { id: "chatonly", label: "Chat Only", bin: "fake-agent", args: () => [] }],
      { PATH: bin },
    );
    cleanups.push(() => launcher.close());

    await expect(launcher.runOnce({ agentId: "ghost", prompt: "p" })).rejects.toThrowError(
      /unknown agent/,
    );
    await expect(
      launcher.runOnce({ agentId: "chatonly", prompt: "p" }),
    ).rejects.toThrowError(/cannot run automations/);
    // agentId omitted → first installed spec that can run one.
    expect((await launcher.runOnce({ prompt: "p" })).status).toBe("ok");

    const nothing = new AgentLauncher(CTX, specs, { PATH: tempDir() });
    await expect(nothing.runOnce({ prompt: "p" })).rejects.toThrowError(
      /no agent CLI is installed/,
    );
    await expect(
      nothing.runOnce({ agentId: "fake", prompt: "p" }),
    ).rejects.toThrowError(/not installed/);
  });

  it("pre-approves platform tools for runs, never chat tools and never message_send", () => {
    const names = runPreapprovedToolNames();
    expect(names).toContain("draft_create");
    expect(names).toContain("messages_search");
    expect(names).toContain("automations_list");
    expect(names).toContain("automation_runs_list");
    expect(names).not.toContain("message_send");
    for (const chat of ["chat_await_message", "chat_say", "chat_activity", "chat_history"]) {
      expect(names).not.toContain(chat);
    }
    // Schedule edits are not a read tool.
    expect(names).not.toContain("automation_create");
    expect(names).not.toContain("automation_delete");
  });
});

describe("automation routes", () => {
  /**
   * Mounted on a bare Hono app, not through createApi: these assertions are
   * about this module's paths and status codes, and the auth middleware is
   * already covered where it lives.
   */
  async function api(): Promise<{ app: Hono; store: AutomationStore }> {
    const { Hono } = await import("hono");
    const { registerAutomationRoutes } = await import("../src/automation/routes.js");
    const store = newStore();
    const app = new Hono();
    registerAutomationRoutes(
      app,
      fakePlatform(store, new AutomationScheduler(store, new FakeLauncher())),
    );
    return { app, store };
  }

  it("serves the CRUD surface with 404s and 400s", async () => {
    const { app } = await api();

    const created = await app.request("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Digest", cron: "0 9 * * 1", prompt: "p" }),
    });
    expect(created.status).toBe(201);
    const id = (await created.json()).automation.id as string;

    const listed = await app.request("/api/automations");
    expect((await listed.json()).automations).toHaveLength(1);

    const badCron = await app.request("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", cron: "nope", prompt: "p" }),
    });
    expect(badCron.status).toBe(400);
    expect((await badCron.json()).error).toMatch(/invalid cron/);

    const patched = await app.request(`/api/automations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await patched.json()).automation.enabled).toBe(false);

    const ghost = await app.request("/api/automations/ghost", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(ghost.status).toBe(404);

    expect((await app.request(`/api/automations/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/automations/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("queues a run and serves run history on both paths", async () => {
    const { app, store } = await api();
    const a = store.create({ name: "a", cron: "0 9 * * 1", prompt: "p" });
    store.finishRun(store.startRun(a.id).id, { status: "ok", exitCode: 0, log: "hello" });

    const queued = await app.request(`/api/automations/${a.id}/run`, { method: "POST" });
    expect(queued.status).toBe(202);
    expect(
      (await app.request("/api/automations/ghost/run", { method: "POST" })).status,
    ).toBe(404);

    // "runs" must not be read as an automation id.
    const all = await app.request("/api/automations/runs");
    expect(all.status).toBe(200);
    expect((await all.json()).runs.length).toBeGreaterThan(0);

    const mine = await app.request(`/api/automations/${a.id}/runs`);
    // Newest first: the run POSTed above, then the seeded one.
    const logs = (await mine.json()).runs.map((r: { log: string }) => r.log);
    expect(logs).toContain("hello");
    expect(logs[0]).toBe("ran");
    expect((await app.request("/api/automations/ghost/runs")).status).toBe(404);

    const overLimit = await app.request(`/api/automations/${a.id}/runs?limit=9999`);
    expect(overLimit.status).toBe(400);
  });
});

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Cron evaluation + serialized one-shot agent runs.
 * Rules: docs/specs/agent-platform.md (AutomationStore / Scheduler).
 *
 * - cron-parser computes next_run_at; a 30s tick enqueues due automations.
 * - Exactly ONE run executes at a time (spec invariant 4), and a run waits
 *   behind an interactive chat agent. Two gates enforce that: the in-process
 *   FIFO here, and underneath it AutomationStore.claimRun, which locks on the
 *   'running' row so a second process (a stdio `sley mcp` with its own
 *   scheduler over the same file) cannot start an overlapping run.
 * - Runs use AgentLauncher's one-shot path (runOnce): fixed preamble +
 *   automation prompt, pre-approved read/draft/CRM/outreach-queue tools,
 *   NEVER message_send, 15-minute timeout.
 */
import { nextRunAfter, type AutomationStore } from "./store.js";
import type { OneShotResult } from "../agent/launcher.js";

/**
 * The slice of AgentLauncher the scheduler uses. Structural, so tests inject a
 * fake and never spawn a real CLI — a scheduler test that shelled out to
 * `claude` would bill the user and hang the suite.
 */
export type OneShotLauncher = {
  busy(): boolean;
  runOnce(opts: {
    agentId?: string | null;
    prompt: string;
  }): Promise<OneShotResult>;
  killRun(): void;
};

const TICK_MS = 30 * 1000;

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Automation ids waiting to run, oldest first. Ids, not rows: the prompt
   *  and cron are re-read at dequeue so an edit mid-queue takes effect. */
  private queue: string[] = [];
  private active: string | null = null;
  private draining: Promise<void> | null = null;

  constructor(
    private store: AutomationStore,
    private launcher: OneShotLauncher,
  ) {
    // A quit or crash mid-run leaves its row 'running' forever: stop() kills
    // the child, but SQLite closes before the close handler can persist
    // 'killed'. Sweeping at construction means the next process to start
    // cleans up after the one that died — and, since a live 'running' row now
    // blocks claims, an unswept row would also wedge every later run.
    this.store.sweepStaleRuns();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    // The in-flight child dies with the process anyway, but killing it here
    // lets the run row finish as 'killed' instead of staying 'running' forever.
    this.launcher.killRun();
  }

  /** Due enabled automations join the queue; the queue then drains serially. */
  async tick(now: Date = new Date()): Promise<void> {
    for (const automation of this.store.due(now)) this.enqueue(automation.id);
    await this.drain();
  }

  /** `automation_run_now` / `POST /api/automations/:id/run`. */
  async runNow(id: string): Promise<void> {
    this.enqueue(id);
    await this.drain();
  }

  /** For the UI and tests: what is running and what is waiting. */
  state(): { active: string | null; queued: string[] } {
    return { active: this.active, queued: [...this.queue] };
  }

  private enqueue(id: string): void {
    // Dedupe against both the queue and the run in flight. A run that outlives
    // its own cron interval would otherwise be re-queued on every tick, and a
    // 15-minute run on a */5 schedule would build a backlog it can never clear.
    if (this.active === id || this.queue.includes(id)) return;
    this.queue.push(id);
  }

  /**
   * Serializes the whole queue. Concurrent callers (the timer and run_now)
   * join the same drain promise instead of starting a second one.
   */
  private drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainLoop().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0) {
      // A chat agent holds the slot: leave the queue intact and let the next
      // tick (or the next runNow) try again. Waiting here would pin the loop
      // to a chat session that can last hours.
      if (this.launcher.busy()) return;
      const id = this.queue.shift()!;
      const outcome = await this.runOne(id);
      // Another process holds the DB run lock. Put the job back at the head
      // and stop draining: the next tick (or runNow) retries it, exactly like
      // the chat-agent case above.
      if (outcome === "deferred") {
        this.queue.unshift(id);
        return;
      }
    }
  }

  private async runOne(id: string): Promise<"ran" | "skipped" | "deferred"> {
    const automation = this.store.get(id);
    // Deleted or disabled while queued: drop it, no run row.
    if (!automation || !automation.enabled) return "skipped";

    // Second gate under the FIFO: the FIFO only knows about this process, the
    // claim also excludes a run started by a `sley mcp` stdio process on
    // the same database (spec invariant 4).
    const run = this.store.claimRun(id);
    if (!run) return "deferred";

    this.active = id;
    try {
      const result = await this.launcher.runOnce({
        agentId: automation.agentId,
        prompt: automation.prompt,
      });
      this.store.finishRun(run.id, {
        status: result.status,
        exitCode: result.exitCode,
        log: result.log,
      });
    } catch (err) {
      // A refusal (no CLI installed, slot taken) is a failed run, recorded:
      // an automation that silently never runs is the worst outcome here.
      this.store.finishRun(run.id, {
        status: "error",
        exitCode: null,
        log: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.active = null;
      // next_run_at is computed from the finish time, not the due time: a run
      // longer than its own interval must land in the future, or the next tick
      // finds it due again immediately.
      const finished = new Date();
      // Re-read: the row may have been edited during the run. A cron change
      // mid-run schedules on the new cron, and disabling mid-run keeps
      // next_run_at null (the store's while-disabled invariant) instead of
      // resurrecting a schedule the user just paused.
      const current = this.store.get(id);
      let nextRunAt: string | null = null;
      if (current?.enabled) {
        try {
          nextRunAt = nextRunAfter(current.cron, finished).toISOString();
        } catch {
          // The cron was validated on save; if it is unparseable now the row
          // was edited outside this store. Leave next_run_at null so it stops
          // firing instead of spinning on a schedule nothing can compute.
        }
      }
      this.store.noteRun(id, finished, nextRunAt);
    }
    return "ran";
  }
}

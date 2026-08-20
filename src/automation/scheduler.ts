/**
 * Cron evaluation + concurrent one-shot agent runs.
 * Rules: docs/specs/agent-platform.md (AutomationStore / Scheduler).
 *
 * - cron-parser computes next_run_at; a 30s tick enqueues due automations.
 * - Up to N runs execute at once (spec invariant 4), and never two of the same
 *   automation. Two gates enforce that: the in-process FIFO here, and
 *   underneath it AutomationStore.claimRun, which counts and locks the
 *   'running' rows so a second process (a stdio `boxaide mcp` with its own
 *   scheduler over the same file) cannot push the total past N or start a
 *   second copy of one automation.
 * - An interactive chat agent no longer holds runs up. It has its own slot in
 *   the launcher, because a chat session can last hours and the schedule
 *   stopped dead behind it.
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
  /** How many more runs it will accept right now. Zero means dispatch stops. */
  runCapacity(): number;
  /** The absolute cap, which is what the cross-process claim is measured against. */
  runLimit(): number;
  runOnce(opts: {
    runId: string;
    agentId?: string | null;
    prompt: string;
    model?: string | null;
  }): Promise<OneShotResult>;
  /** No id kills every live run; shutdown uses that form. */
  killRun(runId?: string): void;
};

const TICK_MS = 30 * 1000;

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Automation ids waiting to run, oldest first. Ids, not rows: the prompt
   *  and cron are re-read at dequeue so an edit mid-queue takes effect. */
  private queue: string[] = [];
  /** Automation ids with a run in flight from this process. */
  private active = new Set<string>();
  /** The in-flight runs themselves, so stop() can wait for them to finish. */
  private inFlight = new Set<Promise<void>>();
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
    // The in-flight children die with the process anyway, but killing them here
    // lets each run row finish as 'killed' instead of staying 'running' forever.
    // No id: every run, not just one.
    this.launcher.killRun();
  }

  /**
   * Kills the runs and waits for their rows to be written. For a shutdown that
   * can afford to wait, and for tests, which otherwise finish while a run is
   * still resolving.
   */
  async stopAndWait(): Promise<void> {
    this.stop();
    await this.idle();
  }

  /**
   * Resolves once nothing is running and nothing is queued.
   *
   * tick() and runNow() return as soon as the runs are started — that is what
   * makes them concurrent — so anything that needs the finished result waits
   * here. Loops because a finishing run dispatches whatever was queued behind
   * it, which puts a new promise in flight after the first batch settles.
   */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0 || this.queue.length > 0) {
      // Nothing is running and no dispatch is under way, so nothing can move
      // the queue: what is waiting needs a slot only another process can free,
      // or a tick that has not happened yet. Waiting here would never end, and
      // the capacity check alone missed it — a run deferred by another process
      // leaves this process with free slots it cannot use.
      if (this.inFlight.size === 0 && !this.draining) return;
      await Promise.allSettled([...this.inFlight, this.draining]);
      // A run that has just settled still has to reach its own cleanup and
      // re-dispatch. Yielding to the macrotask queue lets that land, so the
      // next pass sees the work it started rather than an empty set.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
  state(): { active: string[]; queued: string[] } {
    return { active: [...this.active], queued: [...this.queue] };
  }

  private enqueue(id: string): void {
    // Dedupe against both the queue and the runs in flight. A run that outlives
    // its own cron interval would otherwise be re-queued on every tick, and a
    // 15-minute run on a */5 schedule would build a backlog it can never clear.
    if (this.active.has(id) || this.queue.includes(id)) return;
    this.queue.push(id);
  }

  /**
   * Dispatches the queue. Concurrent callers (the timer and run_now) join the
   * same drain promise instead of starting a second one.
   */
  private drain(): Promise<void> {
    if (this.draining) {
      // The running drain may already be past its last look at the queue, or
      // even in the moment between finishing and clearing itself, so work
      // enqueued now would sit there until the next tick. Chain ONE more pass.
      //
      // One pass, never a loop: a run another process deferred leaves the queue
      // non-empty with slots free here, and a loop on that condition would
      // retry the claim as fast as SQLite could answer it.
      return this.draining.then(() => {
        if (this.draining) return;
        if (this.queue.length === 0 || this.launcher.runCapacity() === 0) return;
        return this.drain();
      });
    }
    this.draining = this.drainLoop().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /**
   * Starts runs while there is capacity, and returns without waiting for them.
   *
   * The loop no longer awaits each run: that is what made the queue serial. It
   * ends when the launcher is full or the queue is empty, and the next tick
   * (or the finish of a run in flight) resumes it.
   */
  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0 && this.launcher.runCapacity() > 0) {
      const id = this.queue.shift()!;
      // Awaited because the claim itself is a synchronous database write and
      // the answer decides whether the slot was taken. The run it starts is
      // not awaited — that is the point.
      const outcome = await this.startOne(id);
      // Another process holds a slot, or this automation is already running
      // somewhere. Put the job back at the head and stop dispatching: the next
      // tick (or runNow) retries it.
      if (outcome === "deferred") {
        this.queue.unshift(id);
        return;
      }
    }
  }

  /**
   * Claims a slot and starts the run, without waiting for it.
   *
   * Returns as soon as the claim is decided, so the caller can fill the next
   * slot. The run's own completion re-enters drain(), which is what keeps a
   * queue longer than the capacity moving without a timer.
   */
  private async startOne(id: string): Promise<"ran" | "skipped" | "deferred"> {
    const automation = this.store.get(id);
    // Deleted or disabled while queued: drop it, no run row.
    if (!automation || !automation.enabled) return "skipped";

    // Second gate under the FIFO. The FIFO only knows about this process; the
    // claim also excludes a run started by a `boxaide mcp` stdio process on the
    // same database, and refuses a second run of this same automation whichever
    // process asks (spec invariant 4).
    // The limit passed is the absolute cap, not this process's free slots: the
    // claim counts every live row across every process, so handing it a
    // remainder would make each running row shrink the ceiling it is measured
    // against and refuse the second run at a limit of two.
    const run = this.store.claimRun(id, { limit: this.launcher.runLimit() });
    if (!run) return "deferred";

    this.active.add(id);
    const running = this.execute(id, run.id, automation).finally(() => {
      this.active.delete(id);
    });
    this.inFlight.add(running);
    void running
      .finally(() => this.inFlight.delete(running))
      // A finished run frees a slot, and whatever is still queued should take
      // it now rather than wait up to 30 seconds for the next tick.
      .then(() => this.drain())
      .catch(() => {});
    return "ran";
  }

  /** One run, start to recorded finish. Never rejects: every end is a row. */
  private async execute(
    id: string,
    runId: string,
    automation: { agentId: string | null; model: string | null; prompt: string },
  ): Promise<void> {
    try {
      const result = await this.launcher.runOnce({
        runId,
        agentId: automation.agentId,
        prompt: automation.prompt,
        model: automation.model,
      });
      this.store.finishRun(runId, {
        status: result.status,
        exitCode: result.exitCode,
        log: result.log,
      });
    } catch (err) {
      // A refusal (no CLI installed, slot taken) is a failed run, recorded:
      // an automation that silently never runs is the worst outcome here.
      this.store.finishRun(runId, {
        status: "error",
        exitCode: null,
        log: err instanceof Error ? err.message : String(err),
      });
    } finally {
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
  }
}

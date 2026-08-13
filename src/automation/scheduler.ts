/**
 * Cron evaluation + serialized one-shot agent runs.
 * Rules: docs/specs/agent-platform.md (AutomationStore / Scheduler).
 *
 * - cron-parser computes next_run_at; a 30s tick enqueues due automations.
 * - Exactly ONE run executes at a time (spec invariant 4), and a run waits
 *   behind an interactive chat agent.
 * - Runs use AgentLauncher's one-shot path (runOnce — to be added in
 *   src/agent/launcher.ts by the automation task, nothing else edits that
 *   file): fixed preamble + automation prompt, pre-approved read/draft/CRM/
 *   outreach-queue tools, NEVER message_send, 15-minute timeout.
 */
import type { AutomationStore } from "./store.js";
import type { AgentLauncher } from "../agent/launcher.js";

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: AutomationStore,
    private launcher: AgentLauncher,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 30 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // TODO(automation): kill an in-flight run's child process.
  }

  async tick(): Promise<void> {
    // TODO(automation): find due enabled automations, enqueue, run serially.
  }
}

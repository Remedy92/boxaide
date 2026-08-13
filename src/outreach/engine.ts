/**
 * Outreach engine: sequence advancement, reply/opt-out detection, and the
 * approved-send loop. Rules: docs/specs/agent-platform.md (OutreachEngine).
 *
 * Invariants enforced here, not by agent goodwill:
 * - Only rows a human approved are ever sent.
 * - Engine sends respect MAILMUX_SEND_DAILY_CAP per account per UTC day and
 *   are spaced >= 60s with +-20s jitter.
 * - Every queued body carries the plain-text opt-out footer. No tracking.
 */
import type { OutreachStore } from "./store.js";
import type { CrmStore } from "../crm/store.js";
import type { MailService } from "../mail/service.js";

export class OutreachEngine {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: OutreachStore,
    private crm: CrmStore,
    private mail: MailService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // TODO(outreach): advance sequences, detect replies/opt-outs, queue steps,
    // send approved rows within cap and spacing.
  }
}

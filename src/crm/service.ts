/**
 * Mail → CRM derivation. Rules: docs/specs/agent-platform.md (Derivation rules).
 *
 * `syncFromMail` walks INBOX + Sent per account, upserts contacts, records
 * interactions, auto-links orgs by non-free-provider domain. `start()` runs it
 * every 10 minutes; the serve process is the only caller of start().
 */
import type { CrmStore } from "./store.js";
import type { MailService } from "../mail/service.js";

export class CrmService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: CrmStore,
    private mail: MailService,
  ) {}

  async syncFromMail(): Promise<{ contacts: number; interactions: number }> {
    // TODO(crm): implement per spec.
    return { contacts: 0, interactions: 0 };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.syncFromMail().catch(() => {});
    }, 10 * 60 * 1000);
    // Timers must not hold the process open on shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

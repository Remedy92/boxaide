/**
 * Outreach engine: the approved-send loop. Rules:
 * docs/specs/agent-platform.md (OutreachEngine).
 *
 * Invariants enforced here, not by agent goodwill:
 * - Only rows a human approved are ever sent.
 * - Engine sends respect BOXAIDE_SEND_DAILY_CAP per account per UTC day and
 *   are spaced >= 60s with +-20s jitter.
 * - Every queued body carries the plain-text opt-out footer (written at queue
 *   time, by the store). No tracking.
 */
import type { OutreachStore } from "./store.js";
import type { MailService } from "../mail/service.js";
import { envNamed } from "../config.js";

const DEFAULT_DAILY_CAP = 50;

/**
 * The floor between two engine sends. Jitter is added on top, never
 * subtracted: "minimum gap of 60s" (spec invariant 5) is the rule, and the
 * randomness only exists so a mailbox does not see a metronome.
 */
const SEND_GAP_MS = 60_000;
const SEND_JITTER_MS = 20_000;

/**
 * Injection seam for tests. Production passes nothing and gets the real clock
 * and a real sleep; a test passes a fixed clock and a no-op sleep so a 60s
 * send gap costs no wall time.
 */
export type EngineDeps = {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  dailyCap?: () => number;
  /**
   * Deliverability check run once per row, just before the send. Wiring in
   * src/platform.ts supplies it; the engine deliberately does not know who
   * answers, so no third party is named in this module. Answering null means
   * "nobody can tell", which is also what an unconfigured install answers,
   * and a null never blocks a send.
   */
  verifyRecipient?: (email: string) => Promise<RecipientVerdict | null>;
};

/** What a verifier says about one address. Mirrors the enrichment result. */
export type RecipientVerdict = {
  status: "valid" | "risky" | "unknown" | "invalid";
  confidence: number;
};

export class OutreachEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSendMs: number | null = null;
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private deps: Required<EngineDeps>;

  constructor(
    private store: OutreachStore,
    private mail: MailService,
    deps: EngineDeps = {},
  ) {
    this.deps = {
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: deps.random ?? Math.random,
      // Read from the environment per call, not at construction: the cap is
      // an operator knob and a serve process should not need a restart.
      dailyCap: deps.dailyCap ?? readDailyCapFromEnv,
      verifyRecipient: deps.verifyRecipient ?? (async () => null),
    };
  }

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

  /**
   * One pass: send approved rows. Ticks coalesce: the hourly timer and the
   * on-demand kicks from the REST routes (approve) may overlap, and two send
   * loops walking the same 'approved' rows would deliver them twice. A tick
   * that arrives while one runs waits for it and schedules exactly one
   * follow-up pass.
   */
  async tick(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      do {
        this.rerun = false;
        await this.sendApproved();
      } while (this.rerun);
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Send the rows a human approved, oldest first, respecting the per-account
   * UTC-day cap and the minimum gap. A row over the cap keeps status
   * 'approved' and goes out on a later tick — it is never dropped.
   */
  async sendApproved(): Promise<number> {
    const cap = this.deps.dailyCap();
    const rows = this.store.listOutbox({ status: "approved", limit: 200 });
    const sentToday = new Map<string, number>();
    let sent = 0;

    for (const row of rows) {
      const nowIso = this.deps.now().toISOString();
      let count = sentToday.get(row.accountId);
      if (count === undefined) {
        count = this.store.countSentOnUtcDay(row.accountId, nowIso);
        sentToday.set(row.accountId, count);
      }
      if (count >= cap) continue;

      // Approval is not a licence to send later: the recipient may have said
      // stop between the human's click and this pass. Fail the row so it
      // leaves the queue with a reason a human can read, rather than being
      // skipped on every tick forever.
      if (this.store.isSuppressed(row.to)) {
        this.store.markFailed(row.id, `recipient suppressed: ${row.to}`);
        continue;
      }

      // A dead address is the cheapest way to lose a sending domain, so the
      // last thing before the send is a deliverability check. Only a verdict
      // of 'invalid' stops the row: 'risky' means a catch-all domain that
      // answers yes to everything, which is unproven rather than bad, and a
      // human already approved this body for this person.
      const verdict = await this.verifyRecipient(row.to);
      if (verdict?.status === "invalid") {
        this.store.markFailed(
          row.id,
          `recipient address did not verify: ${row.to} was reported invalid. Correct the address on the contact and queue a new draft.`,
        );
        continue;
      }

      await this.waitForGap();
      try {
        // No overrideSuppression: only a human at the REST send route may
        // reach a suppressed address, never the engine (spec invariant 2).
        await this.mail.sendMessage(row.accountId, {
          to: row.to,
          subject: row.subject,
          text: row.body,
        });
        this.store.markSent(row.id, this.deps.now().toISOString());
        sentToday.set(row.accountId, count + 1);
        sent += 1;
      } catch (err) {
        // No retry in v1: a failed row keeps its error for the human to read.
        this.store.markFailed(
          row.id,
          err instanceof Error ? err.message : String(err),
        );
      }
      this.lastSendMs = this.deps.now().getTime();
    }
    return sent;
  }

  /**
   * Ask the verifier, and treat any failure as no answer. A vendor outage or
   * an exhausted quota must not hold an approved queue hostage: the check is
   * there to catch a bad address, not to become a second thing that has to be
   * up before mail can leave.
   */
  private async verifyRecipient(email: string): Promise<RecipientVerdict | null> {
    try {
      return await this.deps.verifyRecipient(email);
    } catch {
      return null;
    }
  }

  private async waitForGap(): Promise<void> {
    if (this.lastSendMs === null) return;
    const gap = SEND_GAP_MS + Math.floor(this.deps.random() * SEND_JITTER_MS);
    const elapsed = this.deps.now().getTime() - this.lastSendMs;
    if (elapsed >= gap) return;
    await this.deps.sleep(gap - elapsed);
  }
}

function readDailyCapFromEnv(): number {
  const raw = Number(envNamed("SEND_DAILY_CAP"));
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_CAP;
}

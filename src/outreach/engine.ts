/**
 * Outreach engine: sequence advancement, reply/opt-out detection, and the
 * approved-send loop. Rules: docs/specs/agent-platform.md (OutreachEngine).
 *
 * Invariants enforced here, not by agent goodwill:
 * - Only rows a human approved are ever sent.
 * - Engine sends respect SLEY_SEND_DAILY_CAP per account per UTC day and
 *   are spaced >= 60s with +-20s jitter.
 * - Every queued body carries the plain-text opt-out footer. No tracking.
 */
import type { OutreachStore, ContactState } from "./store.js";
import type { CrmStore } from "../crm/store.js";
import type { MailService } from "../mail/service.js";
import { envFirst } from "../config.js";
import { inboundSince, readContact, type CrmContact } from "./crm-read.js";

/** Inbound text that ends the sequence AND suppresses the address. */
const OPT_OUT_RE =
  /\b(unsubscribe|opt.?out|stop (emailing|mailing|contacting))\b/i;

const DEFAULT_DAILY_CAP = 50;

/**
 * The floor between two engine sends. Jitter is added on top, never
 * subtracted: "minimum gap of 60s" (spec invariant 5) is the rule, and the
 * randomness only exists so a mailbox does not see a metronome.
 */
const SEND_GAP_MS = 60_000;
const SEND_JITTER_MS = 20_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Injection seam for tests. Production passes nothing and gets the real clock
 * and a real sleep; a test passes a fixed clock and a no-op sleep so a
 * multi-day sequence and a 60s send gap cost no wall time.
 */
export type EngineDeps = {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  dailyCap?: () => number;
};

/** {{name}} / {{email}} / {{org}} substitution. Unknown fields stay as-is. */
export function renderTemplate(text: string, contact: CrmContact): string {
  // {{name}} falls back to the email local part: a bare "Hi ," reads worse
  // than a login-ish first name, and the CRM often has no display name.
  const first =
    (contact.name ?? "").trim().split(/\s+/)[0] ||
    contact.email.split("@")[0];
  return text
    .replace(/\{\{\s*name\s*\}\}/g, first)
    .replace(/\{\{\s*email\s*\}\}/g, contact.email)
    .replace(/\{\{\s*org\s*\}\}/g, contact.org ?? "");
}

export class OutreachEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSendMs: number | null = null;
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private deps: Required<EngineDeps>;

  constructor(
    private store: OutreachStore,
    private crm: CrmStore,
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
   * One pass: queue due steps, then send approved rows. Ticks coalesce: the
   * hourly timer and the on-demand kicks from the REST routes (approve,
   * contact add, campaign activation) may overlap, and two send loops walking
   * the same 'approved' rows would deliver them twice. A tick that arrives
   * while one runs waits for it and schedules exactly one follow-up pass.
   */
  async tick(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      do {
        this.rerun = false;
        this.advanceSequences();
        await this.sendApproved();
      } while (this.rerun);
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /* ---- sequences ------------------------------------------------------ */

  /**
   * Queue the next due step for every active contact of every active
   * campaign. Nothing is sent here: every row lands 'pending' and waits for a
   * human (spec invariant 1).
   */
  advanceSequences(): number {
    const nowIso = this.deps.now().toISOString();
    let queued = 0;
    for (const campaign of this.store.listActiveCampaigns()) {
      const steps = this.store.listSteps(campaign.id);
      if (steps.length === 0) continue;
      for (const cc of this.store.dueContacts(campaign.id, nowIso)) {
        const contact = readContact(this.crm.db, cc.contactId);
        if (!contact) continue;

        // Reply check first: a human answered, so the sequence has done its
        // job and any further step would talk over them.
        if (cc.lastSentAt) {
          const state = this.replyState(cc.contactId, cc.lastSentAt, contact);
          if (state) {
            this.store.setContactState(campaign.id, cc.contactId, state);
            continue;
          }
        }

        if (this.store.isSuppressed(contact.email)) {
          this.store.setContactState(campaign.id, cc.contactId, "suppressed");
          continue;
        }

        const next = cc.currentStep + 1;
        const step = steps.find((s) => s.position === next);
        if (!step) {
          this.store.setContactState(campaign.id, cc.contactId, "done");
          continue;
        }

        this.store.queueOutbox({
          accountId: campaign.accountId,
          to: contact.email,
          subject: renderTemplate(step.subject, contact),
          body: renderTemplate(step.body, contact),
          campaignId: campaign.id,
          contactId: cc.contactId,
          stepPosition: step.position,
          createdAt: nowIso,
        });
        queued += 1;

        const following = steps.find((s) => s.position === next + 1);
        this.store.advanceContact(campaign.id, cc.contactId, {
          currentStep: next,
          // Queue time, not send time: it is the earliest moment a reply could
          // be an answer to this step, and the send date is not known yet.
          lastSentAt: nowIso,
          nextDueAt: following
            ? new Date(
                this.deps.now().getTime() + following.waitDays * DAY_MS,
              ).toISOString()
            : null,
          state: following ? "active" : "done",
        });
      }
    }
    return queued;
  }

  /**
   * 'opted_out' (and a suppression entry) when an inbound message asks to
   * stop, 'replied' for any other inbound message, null when silence.
   */
  private replyState(
    contactId: string,
    sinceIso: string,
    contact: CrmContact,
  ): ContactState | null {
    const inbound = inboundSince(this.crm.db, contactId, sinceIso);
    if (inbound.length === 0) return null;
    for (const row of inbound) {
      const text = [row.subjectEnc, row.snippetEnc]
        .filter((v): v is string => Boolean(v))
        .map((v) => this.safeDecrypt(v))
        .join(" ");
      if (OPT_OUT_RE.test(text)) {
        this.store.addSuppression(contact.email, "reply-stop");
        return "opted_out";
      }
    }
    return "replied";
  }

  /** A row we cannot decrypt must not abort the tick for every other contact. */
  private safeDecrypt(payload: string): string {
    try {
      return this.store.decryptText(payload);
    } catch {
      return "";
    }
  }

  /* ---- approved sends -------------------------------------------------- */

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

  private async waitForGap(): Promise<void> {
    if (this.lastSendMs === null) return;
    const gap = SEND_GAP_MS + Math.floor(this.deps.random() * SEND_JITTER_MS);
    const elapsed = this.deps.now().getTime() - this.lastSendMs;
    if (elapsed >= gap) return;
    await this.deps.sleep(gap - elapsed);
  }
}

function readDailyCapFromEnv(): number {
  const raw = Number(envFirst("SLEY_SEND_DAILY_CAP", "MAILMUX_SEND_DAILY_CAP"));
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_CAP;
}

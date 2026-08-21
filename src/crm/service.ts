/**
 * Mail → CRM derivation. Rules: docs/specs/agent-platform.md (Derivation rules).
 *
 * `syncFromMail` walks INBOX + Sent per account, upserts contacts, records
 * interactions, auto-links orgs by non-free-provider domain. `start()` runs it
 * every 10 minutes; the serve process is the only caller of start().
 */
import type { CrmStore } from "./store.js";
import type { MailService } from "../mail/service.js";
import type { MailMessageSummary } from "../provider/types.js";
import { optOutIntent } from "../outreach/opt-out.js";

/** Messages read per folder per sync. Spec: 200. */
const PER_FOLDER_LIMIT = 200;

/**
 * Consumer mail hosts. An address at one of these says nothing about who the
 * person works for, so it must never create an organization — otherwise every
 * inbox grows a "Gmail" company with a hundred unrelated people in it.
 */
const FREE_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "web.de",
  "aol.com",
  "fastmail.com",
  "hey.com",
  "pm.me",
  "mail.com",
  "msn.com",
  "telenet.be",
  "skynet.be",
]);

/**
 * Robots, not people. A CRM full of no-reply@ rows is a CRM nobody opens, and
 * these addresses can never be written back to.
 */
const NO_REPLY = /^(no-?reply|notifications?|mailer-daemon|postmaster|bounce)/i;

/** A folder whose name or special-use marks it as the account's Sent mail. */
const SENT_FOLDER = /sent/i;

/** Called once per freshly flagged inbound opt-out, with the address in hand. */
export type OptOutSink = (contactId: string, email: string) => void;

export class CrmService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private optOutSink: OptOutSink | null = null;
  /** A sync in flight. Two overlapping walks would duplicate no rows (the
   *  interactions UNIQUE holds) but would double the IMAP traffic for nothing. */
  private running: Promise<{ contacts: number; interactions: number }> | null =
    null;

  constructor(
    private store: CrmStore,
    private mail: MailService,
  ) {}

  /**
   * Installed by the platform (src/platform.ts), which scopes it to contacts
   * outreach actually touched before suppressing. CRM stays ignorant of the
   * suppression table itself.
   */
  setOptOutSink(sink: OptOutSink): void {
    this.optOutSink = sink;
  }

  async syncFromMail(): Promise<{ contacts: number; interactions: number }> {
    if (this.running) return this.running;
    this.running = this.walk().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async walk(): Promise<{ contacts: number; interactions: number }> {
    let contacts = 0;
    let interactions = 0;
    const accounts = this.mail.listAccounts();
    // Every mailbox the user owns. A message from work@ to personal@ is the
    // user talking to themselves, and neither address becomes a contact.
    const ownAddresses = new Set(
      accounts.map((a) => a.email.trim().toLowerCase()),
    );

    for (const account of accounts) {
      const own = account.email.trim().toLowerCase();
      for (const folder of await this.foldersToWalk(account.id)) {
        let messages: MailMessageSummary[];
        try {
          const res = await this.mail.listMessages(account.id, {
            folder,
            limit: PER_FOLDER_LIMIT,
            refresh: true,
          });
          messages = res.messages;
        } catch {
          // One unreachable folder must not abandon the other accounts. The
          // next sync in ten minutes tries again.
          continue;
        }

        for (const message of messages) {
          const outbound = addressesOf(message.from).some((a) => a.email === own);
          const counterparties = outbound
            ? [
                ...addressesOf(message.to),
                // MailMessageSummary carries no cc field today. Providers that
                // do surface one are read here rather than dropped, matching
                // the spec's "to + cc" rule as far as the data allows.
                ...addressesOf((message as { cc?: string }).cc),
              ]
            : addressesOf(message.from);

          const parties: Array<{ id: string; email: string }> = [];
          for (const party of counterparties) {
            if (ownAddresses.has(party.email)) continue;
            if (NO_REPLY.test(localPartOf(party.email))) continue;

            const known = this.store.isKnownContact(party.email);
            const contact = this.store.upsertContact({
              email: party.email,
              name: party.name,
              orgId: this.orgIdFor(party.email),
              source: "mail",
            });
            if (!known) contacts += 1;
            parties.push({ id: contact.id, email: party.email });
          }

          // Opt-out is decided from the full body. The walk re-reads the same
          // 200 summaries every ten minutes, so a body already judged (flagged,
          // or fetched and clean) is not fetched again. A first pass that
          // fell back to the snippet because getMessage failed is not a
          // judgement: that row stays retryable until a body arrives.
          const needsDetect =
            !outbound &&
            parties.some((p) =>
              this.store.needsOptOutDecision(account.id, message.id, p.id),
            );
          const verdict = needsDetect
            ? await this.detectOptOut(account.id, message)
            : { optOut: false, fromBody: false };

          for (const party of parties) {
            const added = this.store.addInteraction({
              contactId: party.id,
              accountId: account.id,
              messageId: message.id,
              direction: outbound ? "out" : "in",
              at: message.date,
              subject: message.subject,
              snippet: message.snippet,
              optOut: verdict.optOut,
              fromBody: verdict.fromBody,
            });
            if (added) interactions += 1;
            // Suppression is written HERE, at flag time, with the address in
            // hand — not by a later sweep. A sweep that re-reads old flags
            // resurrects suppressions a human deliberately removed, and a
            // contact deleted between flag and sweep would take the address
            // with it while the approved outbox row lived on. Needs-detect
            // rows only: each message gets one suppress per new verdict, so
            // a human removal stands until the contact says stop again.
            if (verdict.optOut && needsDetect) {
              this.optOutSink?.(party.id, party.email);
            }
          }
        }
      }
    }
    return { contacts, interactions };
  }

  /**
   * Does this inbound message ask us to stop?
   *
   * The full body is the only honest input: the list snippet is 140 characters
   * of whatever the client put first, which for an HTML-only reply is often
   * leaked CSS and for a long reply cuts the phrase off. Subject and body are
   * tested separately — a phrase must never be fabricated across the boundary.
   * A fetch that fails or yields no text falls back to the summary rather than
   * breaking the sync: the interaction is stored unconfirmed and the next
   * walk retries the body. An exception here would cost the whole account
   * its derivation.
   */
  private async detectOptOut(
    accountId: string,
    message: MailMessageSummary,
  ): Promise<{ optOut: boolean; fromBody: boolean }> {
    try {
      const full = await this.mail.getMessage(
        accountId,
        message.id,
        message.folder,
      );
      if (full && full.bodyText.trim()) {
        return {
          optOut:
            optOutIntent(full.subject ?? message.subject, "subject") ||
            optOutIntent(full.bodyText, "body"),
          fromBody: true,
        };
      }
    } catch {
      // Fall through to the summary.
    }
    return {
      optOut:
        optOutIntent(message.subject, "subject") ||
        optOutIntent(message.snippet, "body"),
      fromBody: false,
    };
  }

  /**
   * INBOX plus the account's Sent folder. A mailbox with no /sent/i match is
   * walked INBOX-only rather than guessed at: writing inbound interactions
   * into a folder that is really Archive would corrupt the direction field.
   */
  private async foldersToWalk(accountId: string): Promise<string[]> {
    const folders = ["INBOX"];
    try {
      for (const folder of await this.mail.listFolders(accountId)) {
        if (folder.specialUse === "\\Sent" || SENT_FOLDER.test(folder.name)) {
          if (!folders.includes(folder.path)) folders.push(folder.path);
        }
      }
    } catch {
      // Folder listing is a nicety; INBOX alone is still a useful sync.
    }
    return folders;
  }

  /**
   * Org id for a work address, creating the org on first sight. Free-provider
   * and malformed domains get no org at all.
   */
  private orgIdFor(email: string): string | null {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    if (!domain || !domain.includes(".")) return null;
    if (FREE_PROVIDERS.has(domain)) return null;
    const existing = this.store.getOrgByDomain(domain);
    if (existing) return existing.id;
    return this.store.upsertOrg({ name: orgNameFor(domain), domain }).id;
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

/** "acme-corp.co.uk" → "Acme-corp". Spec: domain without TLD, capitalized. */
export function orgNameFor(domain: string): string {
  const head = domain.split(".")[0] ?? domain;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

function localPartOf(email: string): string {
  return email.split("@")[0] ?? "";
}

/**
 * Split a header value into { name, email } pairs.
 *
 * Deliberately small: header values here come from the provider layer, which
 * has already parsed the MIME. This only has to survive "Jane <j@x.com>",
 * bare addresses, and comma-separated lists of both.
 */
export function addressesOf(
  header: string | undefined | null,
): Array<{ email: string; name: string | null }> {
  if (!header) return [];
  const out: Array<{ email: string; name: string | null }> = [];
  for (const part of header.split(",")) {
    const raw = part.trim();
    if (!raw) continue;
    const angled = /^(.*?)<([^>]+)>\s*$/.exec(raw);
    const email = (angled ? angled[2] : raw).trim().toLowerCase();
    if (!email.includes("@")) continue;
    const name = angled
      ? angled[1].trim().replace(/^["']|["']$/g, "").trim()
      : "";
    out.push({ email, name: name === "" ? null : name });
  }
  return out;
}

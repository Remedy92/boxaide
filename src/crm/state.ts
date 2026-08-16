/**
 * Contact outreach state, worked out from what was recorded rather than from
 * what an agent remembered to write down.
 *
 * The old model asked the model to tag a contact `contacted` after sending.
 * A run that sent the mail and then hit its time limit left the tag unwritten,
 * so the next run saw an untouched contact and mailed them again — or, with
 * `queued` still sitting there from an earlier pass, skipped them forever.
 * Tags are an unordered set with no clock, so "the newest tag wins" was never
 * a question the database could answer.
 *
 * Nothing here is stored. Every field is derived from rows written by the code
 * that performed the act: the mail sync records inbound and outbound mail, the
 * outreach engine records what it queued and sent, opt-out detection records
 * suppression. The one thing that cannot be derived is intent — "I mean to
 * contact this person", "never contact this person" — and that is stored
 * explicitly, with a timestamp, by src/crm/store.ts.
 *
 * Read-only, and the mirror of src/outreach/crm-read.ts: that module reads CRM
 * tables from the outreach engine, this one reads outreach tables from the CRM
 * side. Both go through the single shared handle and neither writes across the
 * seam. Tables can legitimately be absent (a harness that wires one module
 * alone), so every read is guarded.
 */
import type Database from "better-sqlite3";
import { canonicalEmail } from "../outreach/opt-out.js";

/**
 * What happened, in the order that matters when several are true at once.
 * `inbound_only` is a person who wrote to us first and was never mailed by
 * outreach — worth distinguishing, because cold-mailing someone already in
 * conversation is the mistake it exists to prevent.
 */
export type ContactStatus =
  | "new"
  | "inbound_only"
  | "contacted"
  | "replied"
  | "opted_out";

/** A decision a human or agent made, which no record of past mail implies. */
export type ContactIntent = "queued" | "do_not_contact";

/** Why cold outreach is not allowed. First match wins, in this order. */
export type BlockReason =
  | "opted_out"
  | "do_not_contact"
  | "already_queued"
  | "in_conversation"
  | "cooldown";

export type ContactState = {
  contactId: string;
  email: string;
  status: ContactStatus;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  optedOutAt: string | null;
  /** Set while an unsent outreach row exists, or an explicit `queued` intent. */
  queuedAt: string | null;
  intent: ContactIntent | null;
  intentAt: string | null;
  /** The whole point: safe to cold-contact right now, decided by code. */
  contactable: boolean;
  blockedBy: BlockReason | null;
};

/**
 * Days after a send during which the same person is not cold-contacted again.
 * A sequence engine running its own follow-up cadence passes its own wait
 * instead; this default only governs ad-hoc outreach.
 */
export const DEFAULT_COOLDOWN_DAYS = 30;

export type StateOpts = {
  /** Defaults to DEFAULT_COOLDOWN_DAYS. 0 disables the cooldown block. */
  cooldownDays?: number;
  now?: Date;
};

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

/** Newer of two nullable ISO stamps. */
function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Older of two nullable ISO stamps. */
function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

type Row = { contact_id: string; at: string | null };

function byContact(rows: Row[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) if (row.at) out.set(row.contact_id, row.at);
  return out;
}

type ContactRef = { id: string; email: string };

/**
 * The whole derivation, batched: five grouped reads for any number of
 * contacts, not five reads per contact. Absent tables yield empty maps, which
 * degrade to `status: "new"` rather than throwing.
 */
export function contactStates(
  db: Database.Database,
  contacts: readonly ContactRef[],
  opts: StateOpts = {},
): ContactState[] {
  if (contacts.length === 0) return [];
  const ids = contacts.map((c) => c.id);
  const marks = placeholders(ids.length);
  const now = opts.now ?? new Date();
  const cooldownDays = opts.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
  const cooldownFrom =
    cooldownDays > 0
      ? new Date(now.getTime() - cooldownDays * 86_400_000).toISOString()
      : null;

  const inbound = new Map<string, string>();
  const outbound = new Map<string, string>();
  const optOut = new Map<string, string>();
  if (hasTable(db, "interactions")) {
    const rows = db
      .prepare(
        `SELECT contact_id, direction, MAX(at) AS at
           FROM interactions
          WHERE contact_id IN (${marks})
          GROUP BY contact_id, direction`,
      )
      .all(...ids) as Array<Row & { direction: string }>;
    for (const row of rows) {
      if (!row.at) continue;
      (row.direction === "out" ? outbound : inbound).set(row.contact_id, row.at);
    }
    // Earliest, not latest: the moment the request to stop was first seen is
    // the honest answer to "since when", and later mail does not renew it.
    const stops = db
      .prepare(
        `SELECT contact_id, MIN(at) AS at
           FROM interactions
          WHERE opt_out = 1 AND contact_id IN (${marks})
          GROUP BY contact_id`,
      )
      .all(...ids) as Row[];
    for (const [id, at] of byContact(stops)) optOut.set(id, at);
  }

  let queued = new Map<string, string>();
  if (hasTable(db, "outbox")) {
    // A send the engine performed is known here before the Sent folder is
    // walked, so a contact counts as contacted the moment the mail leaves —
    // not up to ten minutes later when the mail sync catches up.
    const sent = byContact(
      db
        .prepare(
          `SELECT contact_id, MAX(sent_at) AS at
             FROM outbox
            WHERE status = 'sent' AND sent_at IS NOT NULL
              AND contact_id IN (${marks})
            GROUP BY contact_id`,
        )
        .all(...ids) as Row[],
    );
    for (const [id, at] of sent) {
      outbound.set(id, later(outbound.get(id) ?? null, at) ?? at);
    }

    queued = byContact(
      db
        .prepare(
          `SELECT contact_id, MIN(created_at) AS at
             FROM outbox
            WHERE status IN ('pending', 'approved') AND contact_id IN (${marks})
            GROUP BY contact_id`,
        )
        .all(...ids) as Row[],
    );
  }

  const suppressed = new Map<string, string>();
  if (hasTable(db, "suppression")) {
    const emails = contacts.map((c) => canonicalEmail(c.email));
    const rows = db
      .prepare(
        `SELECT email, at FROM suppression
          WHERE email IN (${placeholders(emails.length)})`,
      )
      .all(...emails) as Array<{ email: string; at: string }>;
    const byEmail = new Map(rows.map((r) => [r.email, r.at]));
    for (const c of contacts) {
      const at = byEmail.get(canonicalEmail(c.email));
      if (at) suppressed.set(c.id, at);
    }
  }

  const intents = new Map<string, { intent: ContactIntent; at: string }>();
  if (hasTable(db, "contact_intent")) {
    const rows = db
      .prepare(
        `SELECT contact_id, intent, at FROM contact_intent
          WHERE contact_id IN (${marks})`,
      )
      .all(...ids) as Array<{ contact_id: string; intent: string; at: string }>;
    for (const row of rows) {
      if (row.intent === "queued" || row.intent === "do_not_contact") {
        intents.set(row.contact_id, { intent: row.intent, at: row.at });
      }
    }
  }

  return contacts.map((contact) => {
    const lastInboundAt = inbound.get(contact.id) ?? null;
    const lastOutboundAt = outbound.get(contact.id) ?? null;
    // Either signal alone is enough. The earlier one is the honest answer to
    // "opted out since when": suppression is written when a stop reply is
    // seen, so the two normally agree, and when they disagree the first
    // sighting is the one that should have stopped the mail.
    const optedOutAt = earlier(
      suppressed.get(contact.id) ?? null,
      optOut.get(contact.id) ?? null,
    );
    const held = intents.get(contact.id) ?? null;
    const queuedAt =
      queued.get(contact.id) ??
      (held?.intent === "queued" ? held.at : null) ??
      null;

    const status: ContactStatus = optedOutAt
      ? "opted_out"
      : lastInboundAt && lastOutboundAt && lastInboundAt > lastOutboundAt
        ? "replied"
        : lastOutboundAt
          ? "contacted"
          : lastInboundAt
            ? "inbound_only"
            : "new";

    const blockedBy: BlockReason | null = optedOutAt
      ? "opted_out"
      : held?.intent === "do_not_contact"
        ? "do_not_contact"
        : queuedAt
          ? "already_queued"
          : status === "replied"
            ? "in_conversation"
            : cooldownFrom && lastOutboundAt && lastOutboundAt >= cooldownFrom
              ? "cooldown"
              : null;

    return {
      contactId: contact.id,
      email: contact.email,
      status,
      lastOutboundAt,
      lastInboundAt,
      optedOutAt,
      queuedAt,
      intent: held?.intent ?? null,
      intentAt: held?.at ?? null,
      contactable: blockedBy === null,
      blockedBy,
    };
  });
}

/** Single-contact convenience over the batched read. */
export function contactState(
  db: Database.Database,
  contact: ContactRef,
  opts: StateOpts = {},
): ContactState {
  return contactStates(db, [contact], opts)[0];
}

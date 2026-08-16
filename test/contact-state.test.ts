/**
 * Contact state derivation (src/crm/state.ts).
 *
 * The rules these cover exist because the previous model — lifecycle written
 * into `contact_tags` by the agent — could not answer "what happened last".
 * Tags are an unordered set with no timestamp, so a contact could hold
 * 'queued', 'contacted' and 'replied' at once, and a run that sent mail and
 * then hit its time limit left no tag at all. Every case below is one of those
 * failures, restated as an assertion.
 */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CrmStore } from "../src/crm/store.js";
import { OutreachStore } from "../src/outreach/store.js";
import { DEFAULT_COOLDOWN_DAYS, contactState } from "../src/crm/state.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const ACCOUNT = "acct-1";

function harness() {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  const masterKey = randomBytes(32);
  const crm = new CrmStore(db, masterKey);
  const outreach = new OutreachStore(db, masterKey);
  return { db, crm, outreach };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

type H = ReturnType<typeof harness>;

function contact(h: H, email: string) {
  const row = h.crm.upsertContact({ email });
  return { id: row.id, email: row.email };
}

function mail(
  h: H,
  contactId: string,
  direction: "in" | "out",
  at: string,
  optOut = false,
) {
  h.crm.addInteraction({
    contactId,
    accountId: ACCOUNT,
    messageId: randomUUID(),
    direction,
    at,
    optOut,
  });
}

function state(h: H, c: { id: string; email: string }, cooldownDays?: number) {
  return contactState(h.db, c, { cooldownDays });
}

describe("contact state derivation", () => {
  it("reads new when nothing has happened", () => {
    const h = harness();
    const s = state(h, contact(h, "nobody@acme.test"));
    expect(s.status).toBe("new");
    expect(s.contactable).toBe(true);
    expect(s.blockedBy).toBe(null);
  });

  it("ignores lifecycle tags entirely", () => {
    // The exact broken record from the live CRM: three contradictory tags and
    // no way to order them. Under the old rule ("never touch anyone tagged
    // queued") this person was skipped forever. They have no mail, so the
    // honest answer is that they have never been contacted.
    const h = harness();
    const c = contact(h, "tagged@acme.test");
    h.crm.addTags(c.id, ["queued", "contacted", "replied"]);

    const s = state(h, c);
    expect(s.status).toBe("new");
    expect(s.contactable).toBe(true);
    expect(h.crm.listTags(c.id)).toHaveLength(3);
  });

  it("counts an engine send before the Sent folder is walked", () => {
    // The double-send hole. The mail sync runs every ten minutes; until it
    // does, `interactions` holds nothing outbound. The outbox row written by
    // the send itself has to be enough on its own.
    const h = harness();
    const c = contact(h, "justmailed@acme.test");
    const row = h.outreach.queueOutbox({
      accountId: ACCOUNT,
      to: c.email,
      subject: "Hello",
      body: "Body",
      contactId: c.id,
      createdAt: new Date().toISOString(),
    });
    h.outreach.decide(row.id, "approved");
    h.outreach.markSent(row.id, new Date().toISOString());

    const s = state(h, c);
    expect(s.status).toBe("contacted");
    expect(s.lastOutboundAt).not.toBe(null);
    expect(s.blockedBy).toBe("cooldown");
  });

  it("blocks a contact whose mail is still waiting for approval", () => {
    // No send yet, so nothing is 'contacted' — but queueing them twice would
    // put two drafts in front of the user for one person.
    const h = harness();
    const c = contact(h, "pending@acme.test");
    h.outreach.queueOutbox({
      accountId: ACCOUNT,
      to: c.email,
      subject: "Hello",
      body: "Body",
      contactId: c.id,
      createdAt: new Date().toISOString(),
    });

    const s = state(h, c);
    expect(s.status).toBe("new");
    expect(s.queuedAt).not.toBe(null);
    expect(s.blockedBy).toBe("already_queued");
  });

  it("reads replied when inbound follows our last outbound", () => {
    const h = harness();
    const c = contact(h, "answered@acme.test");
    mail(h, c.id, "out", daysAgo(3));
    mail(h, c.id, "in", daysAgo(2));

    const s = state(h, c);
    expect(s.status).toBe("replied");
    expect(s.blockedBy).toBe("in_conversation");
  });

  it("stays contacted when our mail is the most recent", () => {
    // They replied to an older thread and we answered. Still our turn to wait,
    // but they are not a cold prospect either.
    const h = harness();
    const c = contact(h, "midthread@acme.test");
    mail(h, c.id, "in", daysAgo(40));
    mail(h, c.id, "out", daysAgo(39));

    const s = state(h, c);
    expect(s.status).toBe("contacted");
    expect(s.blockedBy).toBe(null); // outside the cooldown
  });

  it("does not cold-pitch someone who wrote to us first", () => {
    // The mail sync turns every correspondent into a contact, so the outreach
    // pool would otherwise include people mid-enquiry. Sending them the cold
    // intro is worse than skipping them.
    const h = harness();
    const c = contact(h, "inbound@acme.test");
    mail(h, c.id, "in", daysAgo(1));

    const s = state(h, c);
    expect(s.status).toBe("inbound_only");
    expect(s.contactable).toBe(false);
    expect(s.blockedBy).toBe("in_conversation");
    // Distinguishable from a real reply: we never wrote to them.
    expect(s.lastOutboundAt).toBe(null);
    expect(s.outboundCount).toBe(0);
  });

  it("blocks on opt-out from either signal, and reports the first sighting", () => {
    const h = harness();
    const c = contact(h, "stop@acme.test");
    mail(h, c.id, "in", daysAgo(5), true);
    h.outreach.addSuppression(c.email, "reply-stop"); // stamped now

    const s = state(h, c);
    expect(s.status).toBe("opted_out");
    expect(s.blockedBy).toBe("opted_out");
    // The stop reply five days ago, not the suppression row written just now.
    expect(new Date(s.optedOutAt!).getTime()).toBeLessThan(
      new Date(daysAgo(4)).getTime(),
    );
  });

  it("opt-out outranks a queued draft", () => {
    const h = harness();
    const c = contact(h, "stopped-but-queued@acme.test");
    h.outreach.queueOutbox({
      accountId: ACCOUNT,
      to: c.email,
      subject: "Hello",
      body: "Body",
      contactId: c.id,
      createdAt: new Date().toISOString(),
    });
    h.outreach.addSuppression(c.email, "manual");

    expect(state(h, c).blockedBy).toBe("opted_out");
  });

  it("applies the cooldown to recent sends and releases it after", () => {
    const h = harness();
    const recent = contact(h, "recent@acme.test");
    mail(h, recent.id, "out", daysAgo(DEFAULT_COOLDOWN_DAYS - 1));
    expect(state(h, recent).blockedBy).toBe("cooldown");

    const old = contact(h, "old@acme.test");
    mail(h, old.id, "out", daysAgo(DEFAULT_COOLDOWN_DAYS + 1));
    expect(state(h, old).blockedBy).toBe(null);

    // A sequence engine running its own cadence turns the default off.
    expect(state(h, recent, 0).blockedBy).toBe(null);
  });

  it("honours stored intent, which no past mail could imply", () => {
    const h = harness();
    const never = contact(h, "never@acme.test");
    h.crm.setIntent(never.id, "do_not_contact", { note: "asked at the event" });
    expect(state(h, never).blockedBy).toBe("do_not_contact");

    const queued = contact(h, "queued@acme.test");
    h.crm.setIntent(queued.id, "queued");
    const s = state(h, queued);
    expect(s.blockedBy).toBe("already_queued");
    expect(s.queuedAt).not.toBe(null);
  });

  it("replaces intent instead of accumulating it", () => {
    // The property tags lacked. One row per contact, so there is never a
    // question of which of two intents is newer.
    const h = harness();
    const c = contact(h, "changed@acme.test");
    h.crm.setIntent(c.id, "queued");
    h.crm.setIntent(c.id, "do_not_contact");

    expect(h.crm.getIntent(c.id)?.intent).toBe("do_not_contact");
    expect(state(h, c).blockedBy).toBe("do_not_contact");
    expect(h.crm.clearIntent(c.id)).toBe(true);
    expect(state(h, c).blockedBy).toBe(null);
  });

  it("survives a database where the outreach tables were never created", () => {
    // A harness that wires the CRM alone must degrade, not throw: an absent
    // table has to read as "nothing happened", never as "blocked".
    const db = new Database(":memory:");
    cleanups.push(() => db.close());
    const crm = new CrmStore(db, randomBytes(32));
    const row = crm.upsertContact({ email: "alone@acme.test" });

    const s = contactState(db, { id: row.id, email: row.email });
    expect(s.status).toBe("new");
    expect(s.contactable).toBe(true);
  });

  it("carries state onto the full contact read", () => {
    const h = harness();
    const c = contact(h, "detail@acme.test");
    mail(h, c.id, "out", daysAgo(1));

    const detail = h.crm.contactDetail({ contactId: c.id });
    expect(detail?.state.status).toBe("contacted");
    expect(detail?.state.contactable).toBe(false);
  });
});

describe("follow-up cadence facts", () => {
  it("counts sends and remembers the first one", () => {
    const h = harness();
    const c = contact(h, "sequence@acme.test");
    mail(h, c.id, "out", daysAgo(21));
    mail(h, c.id, "out", daysAgo(14));

    const s = state(h, c);
    expect(s.outboundCount).toBe(2);
    expect(new Date(s.firstOutboundAt!).getTime()).toBeLessThan(
      new Date(s.lastOutboundAt!).getTime(),
    );
  });

  it("does not double-count a send once the Sent folder is walked", () => {
    // The outbox row and the interaction are the same message, and no id ties
    // them together. Summing would push a contact to "two follow-ups sent"
    // the moment the sync ran, ending the sequence a message early.
    const h = harness();
    const c = contact(h, "synced@acme.test");
    const row = h.outreach.queueOutbox({
      accountId: ACCOUNT,
      to: c.email,
      subject: "Hello",
      body: "Body",
      contactId: c.id,
      createdAt: daysAgo(2),
    });
    h.outreach.decide(row.id, "approved");
    h.outreach.markSent(row.id, daysAgo(2));
    mail(h, c.id, "out", daysAgo(2)); // the sync catching up

    expect(state(h, c).outboundCount).toBe(1);
  });

  it("counts a send the sync has not seen yet", () => {
    const h = harness();
    const c = contact(h, "justsent@acme.test");
    const row = h.outreach.queueOutbox({
      accountId: ACCOUNT,
      to: c.email,
      subject: "Hello",
      body: "Body",
      contactId: c.id,
      createdAt: daysAgo(1),
    });
    h.outreach.decide(row.id, "approved");
    h.outreach.markSent(row.id, daysAgo(1));

    const s = state(h, c);
    expect(s.outboundCount).toBe(1);
    expect(s.firstOutboundAt).not.toBe(null);
  });

  it("counts nothing for a contact never written to", () => {
    const h = harness();
    const s = state(h, contact(h, "untouched@acme.test"));
    expect(s.outboundCount).toBe(0);
    expect(s.firstOutboundAt).toBe(null);
  });
});

describe("un-suppress", () => {
  it("makes a contact selectable again", () => {
    // Cross-module invariant created when the opt-out retry work landed: the
    // un-suppress route removes the suppression row AND clears the interaction
    // flags. State reads both, so if either half were missed the contact would
    // stay blocked forever and the human's decision would do nothing.
    const h = harness();
    const c = contact(h, "cameback@acme.test");
    mail(h, c.id, "in", daysAgo(5), true);
    h.outreach.addSuppression(c.email, "reply-stop");
    expect(state(h, c).blockedBy).toBe("opted_out");

    h.outreach.removeSuppression(c.email);
    h.crm.clearOptOutFlags(c.email);

    const s = state(h, c);
    expect(s.optedOutAt).toBe(null);
    expect(s.status).toBe("inbound_only");
    // Still not a cold-outreach target: they wrote to us and we never replied.
    expect(s.blockedBy).toBe("in_conversation");
  });
});

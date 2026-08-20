import { describe, it, expect } from "vitest";
import {
  parseId,
  parseSince,
  uidWindow,
  withinSince,
  imapErrorText,
  imapAuthOptions,
  smtpAuthOptions,
  mailboxNeedsFullResync,
  indexedUidRange,
  draftsMailboxPath,
  archiveMailboxPath,
  accountMailboxPaths,
  moveUid,
  draftFromImapSource,
} from "../src/provider/imap-smtp.js";
import type { ImapFlow } from "imapflow";
import type { AccountCredentials } from "../src/provider/types.js";

describe("parseId (imap message id round-trip)", () => {
  it("splits a well-formed accountId:folder:uid id", () => {
    expect(parseId("acct:INBOX:42", "acct")).toEqual({
      folder: "INBOX",
      uid: 42,
    });
  });

  it("keeps a folder that itself contains a colon", () => {
    const folder = "Archive:2024";
    const id = `acct:${encodeURIComponent(folder)}:7`;
    expect(id).toContain("%3A");
    expect(parseId(id, "acct")).toEqual({ folder, uid: 7 });
  });

  it("decodes a URL-encoded folder path", () => {
    const folder = "[Gmail]/All Mail";
    const id = `acct:${encodeURIComponent(folder)}:1234`;
    expect(parseId(id, "acct")).toEqual({ folder, uid: 1234 });
  });

  it("treats a bare numeric id as an INBOX uid", () => {
    expect(parseId("42", "acct")).toEqual({ folder: "INBOX", uid: 42 });
  });

  it("returns null for malformed input", () => {
    // no account prefix and not a number
    expect(parseId("not-an-id", "acct")).toBeNull();
    // prefixed but no uid separator
    expect(parseId("acct:INBOX", "acct")).toBeNull();
    // prefixed with a non-numeric uid
    expect(parseId("acct:INBOX:abc", "acct")).toBeNull();
  });

  it("does not match another account's prefix", () => {
    expect(parseId("other:INBOX:5", "acct")).toBeNull();
  });
});

describe("uidWindow (listMessages sequence range)", () => {
  it("returns null for an empty mailbox", () => {
    expect(uidWindow(0, 25)).toBeNull();
  });

  it("returns the whole mailbox when it holds fewer than limit", () => {
    expect(uidWindow(3, 25)).toEqual({ start: 1, end: 3 });
  });

  it("returns exactly limit messages when the mailbox is larger", () => {
    const w = uidWindow(100, 25);
    expect(w).toEqual({ start: 76, end: 100 });
    expect(w!.end - w!.start + 1).toBe(25);
  });

  it("returns the whole mailbox on an exact-limit match", () => {
    expect(uidWindow(25, 25)).toEqual({ start: 1, end: 25 });
  });

  it("pages backwards by offset without overlapping the first page", () => {
    const page1 = uidWindow(100, 25, 0)!;
    const page2 = uidWindow(100, 25, 25)!;
    expect(page1).toEqual({ start: 76, end: 100 });
    expect(page2).toEqual({ start: 51, end: 75 });
    expect(page2.end).toBeLessThan(page1.start);
  });

  it("clamps the last partial page to the oldest message", () => {
    expect(uidWindow(10, 25, 5)).toEqual({ start: 1, end: 5 });
  });

  it("returns null once the offset walks past the oldest message", () => {
    expect(uidWindow(3, 25, 10)).toBeNull();
    expect(uidWindow(3, 25, 3)).toBeNull();
  });
});

describe("mailboxNeedsFullResync", () => {
  it("is true with no stored cursor", () => {
    expect(mailboxNeedsFullResync(null, 1)).toBe(true);
  });

  it("is true when uidvalidity changes", () => {
    expect(mailboxNeedsFullResync({ uidvalidity: 1 }, 2)).toBe(true);
  });

  it("is false when uidvalidity matches", () => {
    expect(mailboxNeedsFullResync({ uidvalidity: 7 }, 7)).toBe(false);
  });
});

describe("indexedUidRange (expunge check stays one range)", () => {
  it("is null with nothing indexed", () => {
    expect(indexedUidRange([])).toBeNull();
    expect(indexedUidRange(undefined)).toBeNull();
  });

  it("spans the lowest and highest uid, unsorted input included", () => {
    expect(indexedUidRange([40, 7, 19])).toEqual({ lowest: 7, highest: 40 });
  });

  it("handles a single uid", () => {
    expect(indexedUidRange([12])).toEqual({ lowest: 12, highest: 12 });
  });

  it("does not blow the stack on a large index", () => {
    const uids = Array.from({ length: 200_000 }, (_, i) => i + 1);
    expect(indexedUidRange(uids)).toEqual({ lowest: 1, highest: 200_000 });
  });
});

describe("draftsMailboxPath (where a draft gets appended)", () => {
  it("prefers the SPECIAL-USE \\Drafts mailbox over any name", () => {
    expect(
      draftsMailboxPath([
        { name: "Drafts", path: "Drafts" },
        { name: "Concepten", path: "Concepten", specialUse: "\\Drafts" },
      ]),
    ).toBe("Concepten");
  });

  it("falls back to the Gmail path when no SPECIAL-USE is advertised", () => {
    expect(
      draftsMailboxPath([
        { name: "INBOX", path: "INBOX" },
        { name: "Drafts", path: "[Gmail]/Drafts" },
      ]),
    ).toBe("[Gmail]/Drafts");
  });

  it("falls back to a common name, case-insensitively", () => {
    expect(
      draftsMailboxPath([
        { name: "INBOX", path: "INBOX" },
        { name: "DRAFTS", path: "INBOX.DRAFTS" },
      ]),
    ).toBe("INBOX.DRAFTS");
  });

  it("never picks Sent or Trash by accident", () => {
    expect(
      draftsMailboxPath([
        { name: "Sent", path: "Sent", specialUse: "\\Sent" },
        { name: "Trash", path: "Trash", specialUse: "\\Trash" },
      ]),
    ).toBeNull();
  });
});

describe("archiveMailboxPath (where an archived message lands)", () => {
  it("prefers the SPECIAL-USE \\Archive mailbox over any name", () => {
    expect(
      archiveMailboxPath([
        { name: "Archive", path: "Archive" },
        { name: "Arkiv", path: "Arkiv", specialUse: "\\Archive" },
      ]),
    ).toBe("Arkiv");
  });

  it("archives to All Mail on Gmail, which is what archiving means there", () => {
    expect(
      archiveMailboxPath([
        { name: "INBOX", path: "INBOX" },
        { name: "All Mail", path: "[Gmail]/All Mail", specialUse: "\\All" },
      ]),
    ).toBe("[Gmail]/All Mail");
  });

  it("finds Gmail's All Mail by path when no SPECIAL-USE is advertised", () => {
    expect(
      archiveMailboxPath([
        { name: "INBOX", path: "INBOX" },
        { name: "All Mail", path: "[Gmail]/All Mail" },
      ]),
    ).toBe("[Gmail]/All Mail");
  });

  it("falls back to a common name, case-insensitively", () => {
    expect(
      archiveMailboxPath([
        { name: "INBOX", path: "INBOX" },
        { name: "ARCHIVE", path: "INBOX.ARCHIVE" },
      ]),
    ).toBe("INBOX.ARCHIVE");
    expect(archiveMailboxPath([{ name: "Arquivo", path: "Arquivo" }])).toBe(
      "Arquivo",
    );
    expect(archiveMailboxPath([{ name: "Archiwum", path: "Archiwum" }])).toBe(
      "Archiwum",
    );
  });

  it("returns null rather than filing mail into Trash or Sent", () => {
    // A wrong guess here is a move the user can only undo in another client,
    // so no match must stay no match.
    expect(
      archiveMailboxPath([
        { name: "Sent", path: "Sent", specialUse: "\\Sent" },
        { name: "Trash", path: "Trash", specialUse: "\\Trash" },
        { name: "Junk", path: "Junk", specialUse: "\\Junk" },
      ]),
    ).toBeNull();
  });
});

/**
 * A hand-rolled ImapFlow double: just the members moveUid touches. This is
 * the only exercise the uidMap/COPYUID handling gets without a live server,
 * which is exactly why moveUid is exported.
 */
function fakeImap(opts: {
  uids?: number[];
  uidMap?: Map<number, number> | null;
  capabilities?: string[];
  moveResult?: false;
}) {
  const calls: string[] = [];
  const client = {
    capabilities: new Map(
      (opts.capabilities ?? ["UIDPLUS"]).map((c) => [c, true as const]),
    ),
    getMailboxLock: async (path: string) => {
      calls.push(`lock:${path}`);
      return { release: () => calls.push("release") };
    },
    search: async () => {
      calls.push("search");
      return opts.uids ?? [];
    },
    messageMove: async (_range: string, destination: string) => {
      calls.push(`move:${destination}`);
      if (opts.moveResult === false) return false;
      return {
        path: "INBOX",
        destination,
        ...(opts.uidMap === null ? {} : { uidMap: opts.uidMap }),
      };
    },
  };
  return { client: client as unknown as ImapFlow, calls };
}

describe("moveUid (the MOVE round trip, on a fake client)", () => {
  const source = { folder: "INBOX", uid: 7 };

  it("names the new id from the COPYUID uidMap", async () => {
    const { client, calls } = fakeImap({ uids: [7], uidMap: new Map([[7, 91]]) });
    const res = await moveUid(client, "acct", source, "Archive");
    expect(res).toEqual({
      moved: true,
      fromFolder: "INBOX",
      toFolder: "Archive",
      id: "acct:Archive:91",
    });
    // The lock is taken on the SOURCE folder and always released.
    expect(calls[0]).toBe("lock:INBOX");
    expect(calls[calls.length - 1]).toBe("release");
  });

  it("reports gone when the uid is no longer in the folder", async () => {
    const { client, calls } = fakeImap({ uids: [] });
    const res = await moveUid(client, "acct", source, "Archive");
    expect(res.moved).toBe(false);
    // No MOVE was issued for a message that is not there.
    expect(calls).not.toContain("move:Archive");
  });

  it("treats a missing COPYUID on a UIDPLUS server as the race being lost", async () => {
    // Another client moved the uid between the SEARCH and the MOVE: the MOVE
    // succeeds as a no-op and returns no uidMap. UIDPLUS makes that
    // distinguishable from a real move, so nothing may be reported moved.
    const { client } = fakeImap({ uids: [7], uidMap: null });
    const res = await moveUid(client, "acct", source, "Archive");
    expect(res.moved).toBe(false);
  });

  it("reports a move without an id on a server without UIDPLUS", async () => {
    const { client } = fakeImap({ uids: [7], uidMap: null, capabilities: [] });
    const res = await moveUid(client, "acct", source, "Archive");
    expect(res).toEqual({ moved: true, fromFolder: "INBOX", toFolder: "Archive" });
  });

  it("refuses a move into the folder the message is already in", async () => {
    const { client, calls } = fakeImap({ uids: [7] });
    await expect(moveUid(client, "acct", source, "INBOX")).rejects.toThrow(
      /already in INBOX/,
    );
    expect(calls).toHaveLength(0);
  });

  it("encodes the destination folder into the new id", async () => {
    const { client } = fakeImap({ uids: [7], uidMap: new Map([[7, 5]]) });
    const res = await moveUid(client, "acct", source, "[Gmail]/All Mail");
    expect(res.id).toBe(`acct:${encodeURIComponent("[Gmail]/All Mail")}:5`);
  });
});

describe("accountMailboxPaths (the per-account LIST cache)", () => {
  function lister(boxes: { name: string; path: string; specialUse?: string }[]) {
    let lists = 0;
    return {
      client: {
        list: async () => {
          lists += 1;
          return boxes;
        },
      },
      count: () => lists,
    };
  }
  const withArchive = [
    { name: "INBOX", path: "INBOX" },
    { name: "Archive", path: "Archive", specialUse: "\\Archive" },
    { name: "Drafts", path: "Drafts", specialUse: "\\Drafts" },
  ];

  it("pays one LIST and serves the second read from cache", async () => {
    const { client, count } = lister(withArchive);
    const a = await accountMailboxPaths(client, "cache-1", { now: 1_000 });
    const b = await accountMailboxPaths(client, "cache-1", { now: 2_000 });
    expect(a).toEqual({ archive: "Archive", drafts: "Drafts", at: 1_000 });
    expect(b).toBe(a);
    expect(count()).toBe(1);
  });

  it("re-LISTs after the TTL and on force", async () => {
    const { client, count } = lister(withArchive);
    await accountMailboxPaths(client, "cache-2", { now: 0 });
    await accountMailboxPaths(client, "cache-2", { now: 6 * 60_000 });
    expect(count()).toBe(2);
    await accountMailboxPaths(client, "cache-2", {
      now: 6 * 60_000,
      force: true,
    });
    expect(count()).toBe(3);
  });

  it("never remembers a missing Archive mailbox", async () => {
    // The error tells the user to create the folder; the very next archive
    // must see it, not wait out a TTL.
    const { client, count } = lister([{ name: "INBOX", path: "INBOX" }]);
    const first = await accountMailboxPaths(client, "cache-3", {
      now: 0,
      needArchive: true,
    });
    expect(first.archive).toBeNull();
    await accountMailboxPaths(client, "cache-3", { now: 1, needArchive: true });
    expect(count()).toBe(2);
    // A caller that does not need Archive keeps reading the cached entry.
    await accountMailboxPaths(client, "cache-3", { now: 2 });
    expect(count()).toBe(2);
  });
});

describe("draftFromImapSource (draft body decode path)", () => {
  const raw = [
    "From: you@example.com",
    "To: client@acme.test",
    "Cc: cc@acme.test",
    "Bcc: quiet@acme.test",
    "Subject: Re: Contract",
    "Message-ID: <draft-1@example.com>",
    "In-Reply-To: <orig@acme.test>",
    "References: <root@acme.test> <orig@acme.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Here is the answer.",
  ].join("\r\n");

  it("recovers the reply headers a draft must round-trip", async () => {
    const draft = await draftFromImapSource("acct", "[Gmail]/Drafts", 12, raw);
    expect(draft.id).toBe(`acct:${encodeURIComponent("[Gmail]/Drafts")}:12`);
    expect(parseId(draft.id, "acct")).toEqual({
      folder: "[Gmail]/Drafts",
      uid: 12,
    });
    expect(draft.to).toBe("client@acme.test");
    expect(draft.cc).toBe("cc@acme.test");
    // Bcc survives only in the stored copy — no envelope carries it.
    expect(draft.bcc).toBe("quiet@acme.test");
    expect(draft.subject).toBe("Re: Contract");
    expect(draft.inReplyTo).toBe("<orig@acme.test>");
    expect(draft.references).toBe("<root@acme.test> <orig@acme.test>");
    expect(draft.bodyText).toContain("Here is the answer.");
  });

  it("prefers the envelope when the fetch supplied one", async () => {
    const draft = await draftFromImapSource("acct", "Drafts", 3, raw, {
      envelope: { subject: "Envelope subject", messageId: "<env@x>" },
    });
    expect(draft.subject).toBe("Envelope subject");
    expect(draft.messageId).toBe("<env@x>");
  });
});

describe("imapErrorText", () => {
  it("replaces bare Command failed with an actionable hint", () => {
    const err = new Error("Command failed");
    expect(imapErrorText(err)).toMatch(/app password/i);
  });

  it("prefers responseText and authentication flags", () => {
    const err = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      responseText: "Invalid credentials",
      code: "EAUTH",
    });
    const text = imapErrorText(err);
    expect(text).toMatch(/authentication failed/i);
    expect(text).toMatch(/Invalid credentials/);
  });
});

const hosts = {
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
};

describe("auth credential mapping (password | xoauth2)", () => {
  it("maps password auth for ImapFlow and Nodemailer", () => {
    const creds: AccountCredentials = {
      ...hosts,
      auth: { kind: "password", user: "u@x.com", pass: "secret" },
    };
    expect(imapAuthOptions(creds)).toEqual({
      user: "u@x.com",
      pass: "secret",
    });
    expect(smtpAuthOptions(creds)).toEqual({
      user: "u@x.com",
      pass: "secret",
    });
  });

  it("maps xoauth2 auth for ImapFlow and Nodemailer", () => {
    const creds: AccountCredentials = {
      ...hosts,
      auth: {
        kind: "xoauth2",
        user: "u@x.com",
        accessToken: "ya29.token",
      },
    };
    expect(imapAuthOptions(creds)).toEqual({
      user: "u@x.com",
      accessToken: "ya29.token",
    });
    expect(smtpAuthOptions(creds)).toEqual({
      type: "OAuth2",
      user: "u@x.com",
      accessToken: "ya29.token",
    });
  });
});

/**
 * The precise half of the since filter. IMAP SINCE compares whole days, so
 * the server hands back everything from that day and these two trim it to the
 * instant the caller asked for. Getting this wrong reintroduces the bug the
 * option exists to fix — a triage run asking for "since 17:00" would silently
 * read the whole day, or drop mail that did arrive inside the window.
 */
describe("since filtering", () => {
  const noon = "2026-08-16T12:00:00.000Z";

  it("rejects input it cannot turn into a time", () => {
    expect(parseSince(undefined)).toBe(null);
    expect(parseSince("")).toBe(null);
    expect(parseSince("last tuesday")).toBe(null);
    expect(parseSince(noon)?.toISOString()).toBe(noon);
  });

  it("keeps mail at or after the instant and drops the rest of that day", () => {
    const since = new Date(noon);
    const at = (iso: string) => ({ uid: 1, internalDate: iso });

    expect(withinSince(at("2026-08-16T12:00:00.000Z"), since)).toBe(true);
    expect(withinSince(at("2026-08-16T18:00:00.000Z"), since)).toBe(true);
    // Same day, before the instant: the part SINCE cannot exclude on its own.
    expect(withinSince(at("2026-08-16T09:00:00.000Z"), since)).toBe(false);
  });

  it("prefers receive time over the sender's Date header", () => {
    const since = new Date(noon);
    // A sender whose clock is a day slow. It really arrived inside the window.
    const head = {
      uid: 1,
      internalDate: "2026-08-16T13:00:00.000Z",
      envelope: { date: "2026-08-15T13:00:00.000Z" },
    };
    expect(withinSince(head, since)).toBe(true);
  });

  it("falls back to the header, then keeps the message when neither is usable", () => {
    const since = new Date(noon);
    expect(
      withinSince({ uid: 1, envelope: { date: "2026-08-16T14:00:00.000Z" } }, since),
    ).toBe(true);
    expect(
      withinSince({ uid: 1, envelope: { date: "2026-08-16T02:00:00.000Z" } }, since),
    ).toBe(false);
    // Undated or unparseable: keeping it is the safe direction — a missed
    // reply is worse than one extra message in the triage list.
    expect(withinSince({ uid: 1 }, since)).toBe(true);
    expect(withinSince({ uid: 1, internalDate: "not a date" }, since)).toBe(true);
  });
});

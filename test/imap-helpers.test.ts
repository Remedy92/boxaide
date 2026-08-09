import { describe, it, expect } from "vitest";
import { parseId, uidWindow } from "../src/provider/imap-smtp.js";

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

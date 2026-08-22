/**
 * Which folder rows accept a dragged message.
 *
 * Every rule here is one the server would enforce anyway, by refusing the move.
 * The point of checking them in the rail is that the user never sees a target
 * that would fail: a row that lights up and then errors is worse than a row
 * that never lit up.
 */
import { describe, expect, it } from "vitest";
import {
  canDropOn,
  canMoveOutOf,
  isMoveDestination,
  type MessageDrag,
} from "../apps/web/src/lib/dnd/message-drag.ts";
import type { MailFolder } from "../apps/web/src/lib/types.ts";

function folder(path: string, specialUse?: string): MailFolder {
  return { name: path, path, specialUse };
}

const ACCOUNT = "0a1b2c3d4e5f6071";
const FOLDERS = [
  folder("INBOX"),
  folder("Archive", "\\Archive"),
  folder("Drafts", "\\Drafts"),
];

const drag: MessageDrag = {
  v: 1,
  accountId: ACCOUNT,
  messageId: `${ACCOUNT}:INBOX:4412`,
  folder: "INBOX",
  subject: "Q3 invoice",
};

function target(over: Partial<Parameters<typeof canDropOn>[1]> = {}) {
  return {
    accountId: ACCOUNT,
    folder: folder("Archive", "\\Archive"),
    accountFolders: FOLDERS,
    ...over,
  };
}

describe("isMoveDestination", () => {
  it("refuses the folder the message is already in, and Drafts", () => {
    expect(isMoveDestination(folder("INBOX"), "INBOX")).toBe(false);
    expect(isMoveDestination(folder("Drafts", "\\Drafts"), "INBOX")).toBe(false);
    expect(isMoveDestination(folder("Archive", "\\Archive"), "INBOX")).toBe(
      true,
    );
  });
});

describe("canMoveOutOf", () => {
  /* The rule moveDestinations reads for the palette's move page and the
     reader's move menu, so the keyboard route offers exactly what the drag
     route accepts. It cannot be checked against moveDestinations itself here:
     that lives in a hook module. */
  it("lets a message leave any folder but Drafts", () => {
    expect(canMoveOutOf("INBOX", FOLDERS)).toBe(true);
    expect(canMoveOutOf("Archive", FOLDERS)).toBe(true);
    expect(canMoveOutOf("Drafts", FOLDERS)).toBe(false);
  });

  it("allows the move when the source is not a folder the mailbox listed", () => {
    expect(canMoveOutOf(undefined, FOLDERS)).toBe(true);
    expect(canMoveOutOf("INBOX.Gone", FOLDERS)).toBe(true);
  });
});

describe("canDropOn", () => {
  it("accepts another folder on the same mailbox", () => {
    expect(canDropOn(drag, target())).toBe(true);
  });

  it("refuses when nothing is being dragged", () => {
    expect(canDropOn(null, target())).toBe(false);
  });

  it("refuses a synthesised parent the server never listed", () => {
    expect(canDropOn(drag, target({ folder: null }))).toBe(false);
  });

  it("refuses a folder on another mailbox", () => {
    expect(canDropOn(drag, target({ accountId: "9f8e7d6c5b4a3021" }))).toBe(
      false,
    );
  });

  it("refuses the folder the message is already in", () => {
    expect(canDropOn(drag, target({ folder: folder("INBOX") }))).toBe(false);
  });

  it("refuses Drafts as a destination", () => {
    expect(
      canDropOn(drag, target({ folder: folder("Drafts", "\\Drafts") })),
    ).toBe(false);
  });

  it("refuses every row when the message is in Drafts", () => {
    const fromDrafts: MessageDrag = { ...drag, folder: "Drafts" };
    for (const listed of FOLDERS) {
      expect(canDropOn(fromDrafts, target({ folder: listed }))).toBe(false);
    }
  });
});

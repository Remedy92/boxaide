/**
 * The rail's folder tree.
 *
 * The delimiter is the whole point of these cases. IMAP LIST is flat, the
 * separator is the server's to declare, and guessing it is the one part of the
 * build that can invent a mailbox nobody has: on a "/" server, splitting on
 * both "/" and "." tears a folder named "foo.bar" into a parent and a child
 * that do not exist.
 */
import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  delimiterOf,
  folderLabel,
} from "../apps/web/src/components/rail/folder-tree.ts";
import type { FolderUnread, MailFolder } from "../apps/web/src/lib/types.ts";

function folder(path: string, over: Partial<MailFolder> = {}): MailFolder {
  return { name: path, path, ...over };
}

describe("delimiterOf", () => {
  it("takes the server's own separator when a folder reports one", () => {
    expect(
      delimiterOf([folder("INBOX", { delimiter: "." }), folder("INBOX/a")]),
    ).toBe(".");
  });

  it("infers from the paths when no folder reports one, preferring /", () => {
    expect(delimiterOf([folder("INBOX"), folder("INBOX/Archive")])).toBe("/");
    expect(delimiterOf([folder("INBOX"), folder("INBOX.Archive")])).toBe(".");
    expect(delimiterOf([folder("INBOX")])).toBe("/");
  });
});

describe("buildFolderTree", () => {
  it("nests on a provider-supplied . delimiter", () => {
    const tree = buildFolderTree([
      folder("INBOX", { delimiter: "." }),
      folder("INBOX.Archive", { delimiter: "." }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.path).toBe("INBOX");
    expect(tree[0]?.depth).toBe(0);
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.path).toBe("INBOX.Archive");
    expect(tree[0]?.children[0]?.label).toBe("Archive");
    expect(tree[0]?.children[0]?.depth).toBe(1);
  });

  it("leaves a folder named foo.bar as one leaf when the delimiter is /", () => {
    const tree = buildFolderTree([
      folder("INBOX", { delimiter: "/" }),
      folder("INBOX/foo.bar", { delimiter: "/" }),
    ]);

    const child = tree[0]?.children ?? [];
    expect(child).toHaveLength(1);
    expect(child[0]?.label).toBe("foo.bar");
    expect(child[0]?.children).toHaveLength(0);
  });

  it("synthesises a parent the server never listed", () => {
    const tree = buildFolderTree([
      folder("INBOX", { delimiter: "." }),
      folder("INBOX.a.b", { delimiter: "." }),
    ]);

    const parent = tree[0]?.children[0];
    expect(parent?.path).toBe("INBOX.a");
    expect(parent?.folder).toBeNull();
    expect(parent?.depth).toBe(1);

    const child = parent?.children[0];
    expect(child?.path).toBe("INBOX.a.b");
    expect(child?.folder?.path).toBe("INBOX.a.b");
    expect(child?.depth).toBe(2);
  });

  it("puts INBOX first and sorts its siblings case-insensitively", () => {
    const tree = buildFolderTree([
      folder("zeta", { delimiter: "/" }),
      folder("Archive", { delimiter: "/" }),
      folder("INBOX", { delimiter: "/" }),
      folder("beta", { delimiter: "/" }),
    ]);

    expect(tree.map((node) => node.path)).toEqual([
      "INBOX",
      "Archive",
      "beta",
      "zeta",
    ]);
  });

  it("drops the empty segments a trailing separator leaves behind", () => {
    const tree = buildFolderTree([
      folder("INBOX.", { delimiter: "." }),
      folder(".", { delimiter: "." }),
    ]);

    expect(tree.map((node) => node.path)).toEqual(["INBOX"]);
    expect(tree[0]?.folder?.path).toBe("INBOX.");
  });
});

describe("folderLabel", () => {
  it("says unread count not known yet when unread is undefined", () => {
    expect(folderLabel("INBOX", undefined)).toBe(
      "Folder INBOX, unread count not known yet",
    );
  });

  it("says no unread only when exact is true and count is 0", () => {
    expect(folderLabel("INBOX", { count: 0, exact: true })).toBe(
      "Folder INBOX, no unread",
    );
  });

  it("says unread count not known yet when count is 0 but exact is false", () => {
    // Partial sync window with 0 unread messages in the window must not claim
    // there are no unread messages in the entire folder.
    expect(folderLabel("INBOX", { count: 0, exact: false })).toBe(
      "Folder INBOX, unread count not known yet",
    );
  });

  it("gives the exact count when exact is true and count > 0", () => {
    expect(folderLabel("INBOX", { count: 5, exact: true })).toBe(
      "Folder INBOX, 5 unread",
    );
  });

  it("gives at least n when exact is false and count > 0", () => {
    expect(folderLabel("INBOX", { count: 5, exact: false })).toBe(
      "Folder INBOX, at least 5 unread",
    );
  });
});


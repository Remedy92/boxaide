import type { MailFolder } from "@/lib/types";

/**
 * The rail's folder tree, built from the flat list IMAP hands back.
 *
 * IMAP LIST is flat: it returns "INBOX", "INBOX.Archive" and "INBOX.Archive.2024"
 * as three unrelated strings, and the hierarchy lives entirely in the separator
 * the server told us about. So the delimiter is taken from the server first and
 * only inferred when no folder reports one.
 *
 * This deliberately does NOT reuse the /[/.]/ split that leafOf in use-move.ts
 * uses for toast copy. There, splitting on both characters can only pick a
 * slightly wrong label, which is cosmetic. Here it would invent a tree edge: on
 * a server whose separator is "/", a mailbox literally named "foo.bar" would be
 * torn into a "foo" parent that does not exist and a "bar" child nobody can
 * open. One separator per account, chosen once for the whole list.
 *
 * A .ts helper rather than code inside folder-list.tsx, following agent-exit.ts,
 * so a root vitest test can import it without a DOM.
 */

export type FolderNode = {
  /** The full path this node stands for, e.g. "INBOX.Archive.2024". */
  path: string;
  /** The last segment, which is what the row prints. */
  label: string;
  /**
   * The listed folder, or null for a node the server never listed. IMAP lists
   * mailboxes flat, so INBOX.a.b can arrive with no INBOX.a, and the missing
   * ancestor is drawn as a label so the child is not stranded at depth 0.
   */
  folder: MailFolder | null;
  depth: number;
  children: FolderNode[];
};

/**
 * The one separator for this account's whole list.
 *
 * The server's own answer wins: a server publishes a single separator, so one
 * folder reporting it settles every path in the list. Inference is the fallback
 * for a provider that reports none, and it prefers "/" only because it is the
 * commoner of the two and the tie has to break somewhere.
 */
export function delimiterOf(folders: MailFolder[]): string {
  for (const folder of folders) {
    if (folder.delimiter && folder.delimiter.length > 0) return folder.delimiter;
  }
  if (folders.some((folder) => folder.path.includes("/"))) return "/";
  if (folders.some((folder) => folder.path.includes("."))) return ".";
  // Nothing in the list splits, so the value is arbitrary and never used.
  return "/";
}

/** INBOX first, then siblings by label, ignoring case and accents. */
function compareNodes(a: FolderNode, b: FolderNode): number {
  const aInbox = a.path.toUpperCase() === "INBOX";
  const bInbox = b.path.toUpperCase() === "INBOX";
  if (aInbox !== bInbox) return aInbox ? -1 : 1;
  return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
}

function sortLevel(nodes: FolderNode[]): FolderNode[] {
  const sorted = [...nodes].sort(compareNodes);
  for (const node of sorted) node.children = sortLevel(node.children);
  return sorted;
}

/**
 * Group a flat folder list into the tree the rail draws.
 *
 * Every prefix of every path becomes a node, so two siblings share one parent
 * object, and a parent the server never listed is synthesised with a null
 * `folder`. A synthesised node is a label and nothing else: it is not a mailbox,
 * so it cannot be opened, cannot carry a count, and cannot take a drop.
 */
export function buildFolderTree(folders: MailFolder[]): FolderNode[] {
  const delimiter = delimiterOf(folders);
  const byPath = new Map<string, FolderNode>();
  const roots = new Map<string, FolderNode>();

  for (const folder of folders) {
    // A trailing or doubled separator produces empty segments that would
    // otherwise become nameless rows. A path that is nothing but separators
    // names no mailbox at all, so it is dropped.
    const segments = folder.path
      .split(delimiter)
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    let parent: FolderNode | null = null;
    for (let i = 0; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i + 1).join(delimiter);
      let node = byPath.get(prefix);
      if (!node) {
        node = {
          path: prefix,
          label: segments[i] as string,
          folder: null,
          depth: i,
          children: [],
        };
        byPath.set(prefix, node);
        if (parent) parent.children.push(node);
        else roots.set(prefix, node);
      }
      if (i === segments.length - 1) node.folder = folder;
      parent = node;
    }
  }

  return sortLevel([...roots.values()]);
}

"use client";

import * as React from "react";
import type { MailFolder } from "@/lib/types";

/**
 * Dragging a message row onto a folder row.
 *
 * This module holds one mutable value for the whole app, which needs saying out
 * loud: dataTransfer.getData returns "" during dragover in every browser, by
 * design, so a drop target cannot read the payload while it is deciding whether
 * it will accept the drop. The MIME body is authoritative on DROP only, and
 * everything decided before that, the dropEffect, the ring, and dimming the
 * rows that cannot take this message, reads the current drag from here instead.
 *
 * It is the second module-level mutable value in the client, after the inflight
 * set in use-move.ts, and it is deliberate for the same kind of reason: the
 * drag is one fact about the whole window, not state belonging to any one row.
 *
 * Everything except useMessageDrag is pure, so a root vitest test can exercise
 * the drop rules without a DOM.
 */

export const MESSAGE_DRAG_MIME = "application/x-boxaide-message+json";

export type MessageDrag = {
  v: 1;
  accountId: string;
  messageId: string;
  /** The folder the message is IN. Not app.folder, which is undefined for Inbox and meaningless under account=all. */
  folder: string;
  /** Only for the text/plain fallback and the drop toast. */
  subject: string;
};

/**
 * Whether a folder is somewhere a message may be moved to.
 *
 * The one home for the two rules the server enforces: a move into the folder
 * the message is already in is a no-op the server refuses, and Drafts is
 * refused by name so that filed mail does not become a draft nobody wrote.
 * The palette's picker and the rail's drop targets both read it from here.
 */
export function isMoveDestination(
  folder: MailFolder,
  sourceFolder: string | undefined,
): boolean {
  return folder.path !== sourceFolder && folder.specialUse !== "\\Drafts";
}

/**
 * Whether a message sitting in `sourceFolder` may leave it at all.
 *
 * imap-smtp.ts refuses to move a message OUT of Drafts as well as into it, so
 * a draft has no destinations whatsoever. The source's special use is the only
 * way to tell, which is why the whole mailbox's folder list has to be handed
 * in. Both the drag path and the picker read the rule from here, or the
 * keyboard route would offer destinations the mouse route hides and the server
 * refuses.
 */
export function canMoveOutOf(
  sourceFolder: string | undefined,
  accountFolders: MailFolder[],
): boolean {
  const source = accountFolders.find(
    (folder) => folder.path === sourceFolder,
  );
  return source?.specialUse !== "\\Drafts";
}

/**
 * Whether this drag may be dropped on this row.
 *
 * Two rules on top of isMoveDestination. A move never crosses mailboxes, so a
 * row in another account's group is not a destination however valid it looks.
 * And a message already in Drafts cannot leave it, so when the source is
 * Drafts no row in that group accepts and the user is never shown a target
 * that would fail.
 */
export function canDropOn(
  drag: MessageDrag | null,
  target: {
    accountId: string;
    /** Null for a synthesised parent: it is not a mailbox on the server. */
    folder: MailFolder | null;
    /** Every folder listed for that account, to resolve the source's special use. */
    accountFolders: MailFolder[];
  },
): boolean {
  if (!drag || !target.folder) return false;
  if (target.accountId !== drag.accountId) return false;
  if (!isMoveDestination(target.folder, drag.folder)) return false;
  return canMoveOutOf(drag.folder, target.accountFolders);
}

/* One drag at a time, because one pointer drags one row. Read through
   useSyncExternalStore the same way useRailSections reads its map: the drag is
   an external fact and every folder row has to re-render the moment it starts,
   not only when the pointer reaches it. */
let current: MessageDrag | null = null;
const watchers = new Set<() => void>();

function notify(): void {
  for (const listener of watchers) listener();
}

export function beginMessageDrag(drag: MessageDrag): void {
  current = drag;
  notify();
}

/** Always called from dragend, including on a drag the user cancelled. */
export function endMessageDrag(): void {
  if (!current) return;
  current = null;
  notify();
}

export function currentMessageDrag(): MessageDrag | null {
  return current;
}

export function subscribeMessageDrag(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

/* Null on the server, so the prerendered HTML and the first client render
   agree: nothing is being dragged before the page is interactive. */
function serverSnapshot(): MessageDrag | null {
  return null;
}

export function useMessageDrag(): MessageDrag | null {
  return React.useSyncExternalStore(
    subscribeMessageDrag,
    currentMessageDrag,
    serverSnapshot,
  );
}

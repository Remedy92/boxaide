"use client";

import * as React from "react";
import {
  Archive,
  ChevronRight,
  FilePen,
  Folder,
  Send,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { NavItem } from "@/components/rail/nav-item";
import {
  buildFolderTree,
  folderLabel,
  type FolderNode,
} from "@/components/rail/folder-tree";
import { Button } from "@/components/ui/button";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useFolders, useFolderGroups } from "@/lib/hooks/use-folders";
import { useMoveTo } from "@/lib/hooks/use-move";
import { useRailSections } from "@/lib/hooks/use-rail-sections";
import { cn } from "@/lib/utils";
import {
  MESSAGE_DRAG_MIME,
  canDropOn,
  type MessageDrag,
} from "@/lib/dnd/message-drag";
import { useMessageDrag } from "@/lib/dnd/use-message-drag";
import type { FolderGroup, MailFolder } from "@/lib/types";

/**
 * §6.2 row 5. Rendered from GET /api/folders, one mailbox at a time or grouped
 * by mailbox under "All mailboxes".
 *
 * These icons label a folder the server listed; they are not actions. The row
 * itself does two things beyond navigating. It is a drop target for a message
 * dragged out of the list, which lands as the same move the palette's "Move to
 * folder" page performs, and it can carry an unread count read from the local
 * index. A count is drawn only for a folder the index has actually synced: a
 * folder it has never seen carries no number at all, because a confident 0 over
 * a mailbox holding 400 unread would poison every other count in the app.
 */
const SPECIAL_ICON: Record<string, LucideIcon> = {
  "\\sent": Send,
  "\\drafts": FilePen,
  "\\trash": Trash2,
  "\\junk": ShieldAlert,
  "\\archive": Archive,
};

function iconFor(folder: MailFolder): LucideIcon {
  const key = folder.specialUse?.toLowerCase();
  return (key && SPECIAL_ICON[key]) || Folder;
}

/**
 * The last segment of a path, for the label the folded row carries.
 *
 * Split on both separators, like use-move's leafOf and unlike buildFolderTree:
 * with the section folded there is no folder list loaded to read the account's
 * real delimiter from, and the worst this can do is print a slightly short
 * label on a mailbox whose name contains a dot. It draws no tree edge.
 */
function leafOf(path: string): string {
  const parts = path.split(/[/.]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** Its own id in the rail's saved open map, alongside "mail" and "crm". */
const FOLDERS_SECTION = "mail-folders";

/** Unique per row: two mailboxes both have an INBOX. */
function rowKey(accountId: string, path: string): string {
  return `${accountId} ${path}`;
}

export function FolderList({
  accountRef,
  activeFolder,
  onSelect,
  collapsed = false,
  disabled = false,
}: {
  accountRef: string;
  activeFolder: string | undefined;
  /**
   * The alias is passed only under "All mailboxes", where clicking a folder
   * also has to switch to the mailbox that owns it: a folder belongs to exactly
   * one account, and filtering every account's list by one account's path would
   * be a lie.
   */
  onSelect: (path: string | undefined, accountAlias?: string) => void;
  collapsed?: boolean;
  /** True while another view owns the list pane: no folder is current then. */
  disabled?: boolean;
}) {
  const all = accountRef === "all";
  const sections = useRailSections();
  /* Folded by default. Folders are the deepest thing in the rail and the least
     often reached for: most sessions never leave the inbox, and an unfolded
     tree of forty mailboxes pushes everything under Mail off the bottom. */
  const open = sections.isOpen(FOLDERS_SECTION, false);
  /* Gated on `open`, so a folded section is not relisting every mailbox over
     IMAP. Both queries are shared caches, so anything else that needs a folder
     list, the palette or the reader's move menu, still fills them. */
  const single = useFolders(open ? accountRef : "");
  const grouped = useFolderGroups(all && open);
  const accounts = useAccounts();
  const moveTo = useMoveTo();
  const drag = useMessageDrag();
  /* The hovered row is remembered together with the drag it belongs to, and
     the two are compared by identity below. A drag that ends anywhere but on a
     folder row, dropped on the list or cancelled with Escape, leaves no
     dragleave behind on the row it was last over, and without the pairing the
     next drag would open with a ring around a row the pointer is nowhere near.
     beginMessageDrag builds a fresh object per drag, so the stale pair simply
     never matches. */
  const [hovered, setHovered] = React.useState<{
    key: string;
    drag: MessageDrag;
  } | null>(null);

  /* One mailbox answers a flat list with no id in it, and the drop rules need
     the real account id to compare against the dragged message's. `accountRef`
     is usually the alias, so it is resolved here; until the accounts query
     answers there is no id to compare and no row accepts a drop, which is the
     honest state rather than a guess. */
  const groups: FolderGroup[] = React.useMemo(() => {
    if (all) return grouped.data?.groups ?? [];
    const folders = single.data;
    if (!folders) return [];
    const account = (accounts.data ?? []).find(
      (row) => row.id === accountRef || row.alias === accountRef,
    );
    return [
      {
        accountId: account?.id ?? "",
        alias: account?.alias ?? accountRef,
        email: account?.email ?? "",
        folders,
      },
    ];
  }, [accountRef, accounts.data, all, grouped.data, single.data]);

  const live = all ? grouped : single;
  const errors = all ? (grouped.data?.errors ?? []) : [];

  if (collapsed) return null;

  const moveMutate = moveTo.mutate;

  function dropHandlers(group: FolderGroup, folder: MailFolder) {
    const target = {
      accountId: group.accountId,
      folder,
      accountFolders: group.folders,
    };
    const key = rowKey(group.accountId, folder.path);
    const accepts = canDropOn(drag, target);

    /* preventDefault in BOTH dragenter and dragover, and only on a row that
       accepts: without it the browser never fires a drop at all. */
    const allow = (event: React.DragEvent<HTMLButtonElement>) => {
      if (!accepts) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (drag) setHovered({ key, drag });
    };

    return {
      state: (drag
        ? hovered?.drag === drag && hovered.key === key && accepts
          ? "over"
          : accepts
            ? "idle"
            : "invalid"
        : "idle") as "idle" | "over" | "invalid",
      onDragEnter: allow,
      onDragOver: allow,
      onDragLeave: (event: React.DragEvent<HTMLButtonElement>) => {
        // dragenter and dragleave fire for descendants too, so a leave into the
        // row's own icon or label would otherwise drop the ring mid-hover.
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setHovered((current) => (current?.key === key ? null : current));
      },
      onDrop: (event: React.DragEvent<HTMLButtonElement>) => {
        event.preventDefault();
        setHovered(null);
        const raw = event.dataTransfer.getData(MESSAGE_DRAG_MIME);
        if (!raw) return;
        let payload: MessageDrag;
        try {
          payload = JSON.parse(raw) as MessageDrag;
        } catch {
          // Something else was dropped on the rail. Nothing to move.
          return;
        }
        // The MIME body is the authority on drop, so the rules are re-run
        // against what actually landed rather than against the live drag.
        if (!canDropOn(payload, target)) return;
        moveMutate({
          accountId: payload.accountId,
          messageId: payload.messageId,
          folder: folder.path,
        });
      },
    };
  }

  function renderNode(group: FolderGroup, node: FolderNode): React.ReactNode {
    const children =
      node.children.length > 0 ? (
        <ul className="list-none">
          {node.children.map((child) => renderNode(group, child))}
        </ul>
      ) : null;

    /* A parent the server never listed. IMAP lists mailboxes flat, so
       INBOX.a.b can arrive with no INBOX.a, and the label is drawn so the
       child is not stranded at depth 0. It is not a mailbox: nothing is known
       about it, so it carries no count, takes no drop and cannot be opened. */
    if (!node.folder) {
      return (
        <li key={rowKey(group.accountId, node.path)}>
          <span
            className="block h-7 truncate text-[13px] leading-[28px] text-fg-tertiary"
            style={{ paddingLeft: 8 + 12 * Math.min(node.depth, 4) }}
          >
            {node.label}
          </span>
          {children}
        </li>
      );
    }

    const folder = node.folder;
    const unread = folder.unread;
    const active = !disabled && activeFolder === folder.path;

    return (
      <li key={rowKey(group.accountId, folder.path)}>
        <NavItem
          icon={iconFor(folder)}
          label={node.label}
          title={folder.path}
          ariaLabel={folderLabel(folder.path, unread)}
          depth={node.depth}
          active={active}
          onClick={() =>
            onSelect(
              active ? undefined : folder.path,
              all ? group.alias : undefined,
            )
          }
          /* The quiet count the rail already uses for a folded section, not a
             Badge: a pill on every folder row reads as a row of alerts. "n+"
             marks a number the index can only promise as a floor. */
          trailing={
            unread && unread.count > 0 ? (
              <span className="pr-1 text-[11px] leading-4 tabular-nums text-fg-tertiary">
                {unread.count}
                {unread.exact ? "" : "+"}
              </span>
            ) : undefined
          }
          drop={dropHandlers(group, folder)}
        />
        {children}
      </li>
    );
  }

  const region = `rail-section-${FOLDERS_SECTION}`;

  return (
    <div className="space-y-0.5">
      {/* Not a SectionLabel: this is a row inside Mail, not a peer of it, so it
          takes the same 28px shape as Inbox and Drafts and folds from the
          chevron on its right rather than announcing itself in 11px caps. */}
      <button
        type="button"
        onClick={() => sections.toggle(FOLDERS_SECTION, false)}
        aria-expanded={open}
        aria-controls={region}
        className={cn(
          "flex h-7 w-full items-center gap-2 rounded-[var(--radius-md)] px-2 text-left",
          "text-fg-secondary transition-colors duration-[var(--dur-fast)] hover:duration-0",
          "hover:bg-surface-hover hover:text-fg",
        )}
      >
        <Folder
          aria-hidden="true"
          strokeWidth={1.5}
          className="size-4 shrink-0 text-fg-tertiary"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">
          Folders
        </span>
        {/* Folded, the open folder is still named. Otherwise the list would be
            filtered to a mailbox with nothing on screen saying which. */}
        {!open && !disabled && activeFolder ? (
          <span className="min-w-0 max-w-[96px] truncate text-[11px] leading-4 text-fg-tertiary">
            {leafOf(activeFolder)}
          </span>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.5}
          className={cn(
            "size-3 shrink-0 text-fg-tertiary transition-transform duration-[var(--dur-fast)] motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>

      {/* Unmounted, not hidden: a folded section must not keep rendering rows
          that fetch, poll or measure. */}
      {open ? (
        <div id={region}>
          {live.isPending ? (
            <p className="px-2 py-1 text-[12px] leading-4 text-fg-tertiary">
              Loading folders…
            </p>
          ) : live.isError ? (
            <div role="status" className="px-2 py-1">
              <p className="text-[12px] leading-4 text-danger">
                Could not list folders.
              </p>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-6 px-0"
                onClick={() => void live.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <>
              {/* One mailbox that did not answer never takes the rail with it: it
                says so on its own line and every other mailbox still draws. */}
              {errors.map((error) => (
                <p
                  key={error.account}
                  className="px-2 py-1 text-[12px] leading-4 text-danger"
                >
                  Could not list folders for {error.account}.
                </p>
              ))}

              {groups.map((group) => (
                <div key={group.accountId || group.alias}>
                  {all && (
                    <div
                      id={`folders-${group.accountId}`}
                      title={group.email}
                      className="truncate px-2 pt-1 pb-0.5 text-[11px] leading-4 font-medium text-fg-tertiary"
                    >
                      {group.alias}
                    </div>
                  )}
                  {/* Nested lists, not role="tree": a tree role promises full
                    arrow-key traversal that nothing here implements. Ancestry is
                    in each row's accessible name, which carries the full path. */}
                  <ul
                    className="list-none"
                    aria-labelledby={
                      all ? `folders-${group.accountId}` : undefined
                    }
                    aria-label={all ? undefined : "Folders"}
                  >
                    {buildFolderTree(group.folders).map((node) =>
                      renderNode(group, node),
                    )}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

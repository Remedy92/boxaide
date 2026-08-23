"use client";

import * as React from "react";
import { Archive, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgent } from "@/lib/hooks/use-agent";
import { useApp } from "@/lib/hooks/use-app-state";
import type { AgentChat } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * How many chats the rail shows.
 *
 * Fixed, and deliberately small. The rail must not grow with the history: five
 * conversations and five hundred have to leave the mailboxes in the same place
 * on screen. Everything past this lives in the all-chats dialog, which has the
 * search box.
 */
const RECENT = 5;

/**
 * The longest title the server keeps, from TITLE_CHARS in agent/channel.ts. It
 * trims to this on save either way; stopping the typing is the honest version.
 */
const TITLE_CHARS = 60;

/** One decimal past a megabyte is noise on a number nobody acts on. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function ChatsSection({
  onOpenAll,
  onNavigate,
}: {
  onOpenAll: () => void;
  /** Dismiss whatever surface the rail is being shown in — see LeftRail. */
  onNavigate?: () => void;
}) {
  const agent = useAgent();
  const recent = agent.chats.slice(0, RECENT);
  const rest = Math.max(agent.chats.length - recent.length, 0);

  /* Archiving is reversible and says so in a toast, so it happens on the click.
     Deleting is not, and a permanent loss one pixel away from the row a user
     meant to open has to be asked about first. */
  const [pendingDelete, setPendingDelete] = React.useState<AgentChat | null>(null);

  if (agent.connection === "unsupported") return null;

  return (
    <div className="space-y-px">
      {recent.length === 0 && (
        <p className="px-2 py-1 text-[12px] leading-4 text-fg-tertiary">
          No chats yet.
        </p>
      )}
      {recent.map((chat) => (
        <ChatRow
          key={chat.id}
          chat={chat}
          onDelete={() => setPendingDelete(chat)}
          onNavigate={onNavigate}
        />
      ))}

      {/* Not dismissed here: the dialog opens on top, and tearing the sheet
          down in the same tick would fight it for focus. The dialog drops the
          rail itself, on the way out, once a chat is picked. */}
      <button
        type="button"
        onClick={onOpenAll}
        className="flex h-6 w-full items-center rounded-[var(--radius-md)] pr-2 pl-5 text-left text-[12px] leading-4 text-fg-tertiary transition-colors duration-[var(--dur-fast)] hover:text-accent"
      >
        {rest > 0 || agent.storage.archived > 0
          ? `All chats · ${agent.storage.chats + agent.storage.archived}`
          : "All chats"}
      </button>

      {/* One line, and only once the server has answered with a real budget.
          A storage figure that reads 0 of 0 while the first request is in
          flight is worse than no figure at all. */}
      {agent.storage.budget > 0 && (
        <p className="pr-2 pl-5 text-[11px] leading-4 text-fg-tertiary tabular-nums">
          {formatBytes(agent.storage.bytes)} of {formatBytes(agent.storage.budget)}
        </p>
      )}

      <DeleteChatConfirm
        chat={pendingDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

/**
 * The one question asked before a conversation is destroyed.
 *
 * Shared with the all-chats dialog rather than written twice: the rail and the
 * dialog delete through the same route, and two wordings for one irreversible
 * act is how a user learns to read neither. Pass the chat to ask about, or null
 * to keep it shut.
 */
export function DeleteChatConfirm({
  chat,
  onClose,
}: {
  chat: AgentChat | null;
  onClose: () => void;
}) {
  const agent = useAgent();

  return (
    <AlertDialog
      open={chat !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            “{chat?.title}” and every message in it go for good. Nothing
            undoes this.{" "}
            {/* Offering to archive a chat that is already archived reads as a
                machine that has not looked at what it is asking about. */}
            {chat?.archivedAt
              ? "Archiving it kept every message. This does not."
              : "To put it away instead, archive it."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              const doomed = chat;
              onClose();
              if (doomed) void agent.removeChat(doomed.id);
            }}
          >
            Delete chat
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * One conversation in the rail, with its housekeeping actions.
 *
 * Archive and Delete sit on the row itself, revealed on hover. They take no
 * width until then: the rail is narrow, the title is what the user reads, and
 * a pair of icons parked on every row all day would compete with it. They stay
 * in the DOM rather than being mounted on hover, so Tab still reaches them. A
 * hidden control is a control a keyboard cannot use.
 *
 * The right button opens the same two plus Rename, which has no room on the
 * row and does not want one: renaming is rare, and a third icon would cost
 * every row width to serve it. Radix opens the menu from Shift+F10 and the
 * Menu key as well, so Rename is not mouse-only.
 */
function ChatRow({
  chat,
  onDelete,
  onNavigate,
}: {
  chat: AgentChat;
  onDelete: () => void;
  /** Dismiss whatever surface the rail is being shown in — see LeftRail. */
  onNavigate?: () => void;
}) {
  const agent = useAgent();
  const app = useApp();
  const current = chat.id === agent.chat?.id;
  const [renaming, setRenaming] = React.useState(false);
  const titleRef = React.useRef<HTMLButtonElement>(null);

  /* Leaving the editor hands the keyboard back to the row it came from. The
     input is gone by then, so without this focus lands on <body> and the next
     Tab starts from the top of the page. */
  const stopRenaming = React.useCallback(() => {
    setRenaming(false);
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }, []);

  const archive = () => {
    void agent.archiveChat(chat.id).then(() => {
      toast.success("Chat archived", {
        description: chat.title,
        action: {
          label: "Undo",
          onClick: () => void agent.unarchiveChat(chat.id),
        },
      });
    });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group/chat flex h-7 w-full items-center rounded-[var(--radius-md)] pr-1 pl-5",
            "transition-colors duration-[var(--dur-fast)] hover:duration-0",
            current ? "bg-accent-subtle" : "hover:bg-surface-hover",
          )}
        >
          {renaming ? (
            <RenameInput
              title={chat.title}
              onCancel={stopRenaming}
              onCommit={(next) => {
                stopRenaming();
                if (next !== chat.title) void agent.renameChat(chat.id, next);
              }}
            />
          ) : (
            <button
              ref={titleRef}
              type="button"
              onClick={() => {
                /* Selecting a conversation means wanting to read it: the row
                   also brings the Agent view forward, and drops the sheet or
                   popover the rail was being shown in, so one tap does the
                   whole job. */
                onNavigate?.();
                app.setView("agent");
                void agent.openChat(chat.id);
              }}
              aria-current={current ? "true" : undefined}
              title={chat.title}
              className={cn(
                "min-w-0 flex-1 truncate py-0 pr-1 text-left text-[13px] leading-[18px]",
                current
                  ? "font-medium text-accent"
                  : "text-fg-secondary group-hover/chat:text-fg",
              )}
            >
              {chat.title}
            </button>
          )}

          {/* Nothing to reveal while the title is being edited: the two icons
              would sit under the cursor of someone aiming at their own text. */}
          {!renaming && (
            <div
              className={cn(
                "flex w-0 items-center overflow-hidden opacity-0",
                "transition-opacity duration-[var(--dur-fast)] motion-reduce:transition-none",
                "group-hover/chat:w-auto group-hover/chat:opacity-100",
                "group-focus-within/chat:w-auto group-focus-within/chat:opacity-100",
              )}
            >
              <RowAction label="Archive this chat" onClick={archive}>
                <Archive strokeWidth={1.5} />
              </RowAction>
              <RowAction label="Delete this chat" destructive onClick={onDelete}>
                <Trash2 strokeWidth={1.5} />
              </RowAction>
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-48">
        {/* A tick later: Radix returns focus to the trigger as it closes, and
            a rename input focused in the same breath loses it again. */}
        <ContextMenuItem
          onSelect={() => window.setTimeout(() => setRenaming(true), 0)}
        >
          <Pencil strokeWidth={1.5} />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={archive}>
          <Archive strokeWidth={1.5} />
          Archive
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 strokeWidth={1.5} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The title, editable in place. Shared with the all-chats dialog.
 *
 * Enter and blur commit, Escape abandons. An empty box is not a rename: a chat
 * with no title is a row a user cannot tell from its neighbours, so it falls
 * back to what was there. The cap is the server's own, applied here so a long
 * title is stopped while it is being typed rather than silently cut on save.
 */
export function RenameInput({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  /* Escape has to beat the blur it causes. Without the flag, abandoning an
     edit saves it. */
  const abandoned = React.useRef(false);

  return (
    <input
      autoFocus
      defaultValue={title}
      maxLength={TITLE_CHARS}
      aria-label="Chat title"
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(event.currentTarget.value.trim() || title);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          abandoned.current = true;
          onCancel();
        }
      }}
      onBlur={(event) => {
        if (abandoned.current) return;
        onCommit(event.currentTarget.value.trim() || title);
      }}
      className={cn(
        "min-w-0 flex-1 rounded-[var(--radius-sm)] bg-surface-2 px-1 py-0",
        "text-[13px] leading-[18px] text-fg outline-none",
        "ring-1 ring-accent",
      )}
    />
  );
}

function RowAction({
  label,
  destructive = false,
  onClick,
  children,
}: {
  label: string;
  destructive?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={onClick}
          className={cn(
            "text-fg-tertiary",
            destructive ? "hover:text-danger" : "hover:text-fg",
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The one primary action in the rail, pinned above the scroll area. A
 * conversation is what this app is for, so it is the button that never scrolls
 * away; Compose is a row under Mail.
 *
 * Nothing renders when the agent bridge is unsupported — a button that cannot
 * start a chat is worse than a rail that does not offer one.
 */
export function NewChatButton({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  /** Dismiss whatever surface the rail is being shown in — see LeftRail. */
  onNavigate?: () => void;
}) {
  const agent = useAgent();
  const app = useApp();
  if (agent.connection === "unsupported") return null;

  /* Secondary, not the accent fill. A full-width saturated block at the top of
     the sidebar would be the loudest thing on screen, and the accent is spent
     on selection, focus and the unread dot — the states that carry meaning. */
  const button = (
    <Button
      type="button"
      variant="secondary"
      size={collapsed ? "icon" : "default"}
      aria-label={collapsed ? "New chat" : undefined}
      onClick={() => {
        onNavigate?.();
        app.setView("agent");
        void agent.newChat();
      }}
      className={collapsed ? "" : "w-full justify-start bg-surface-2 font-medium"}
    >
      <Plus aria-hidden="true" className="size-4 text-fg-tertiary" strokeWidth={1.5} />
      {!collapsed && "New chat"}
    </Button>
  );

  if (!collapsed) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">New chat</TooltipContent>
    </Tooltip>
  );
}

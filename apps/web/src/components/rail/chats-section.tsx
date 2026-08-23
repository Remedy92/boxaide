"use client";

import * as React from "react";
import { Archive, Plus, Trash2 } from "lucide-react";
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

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.title}” and every message in it go for good.
              Nothing undoes this. To put it away instead, archive it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const chat = pendingDelete;
                setPendingDelete(null);
                if (chat) void agent.removeChat(chat.id);
              }}
            >
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One conversation in the rail, with its two housekeeping actions.
 *
 * The actions take no width until the row is hovered or holds focus: the rail
 * is narrow, the title is what the user reads, and a pair of icons parked on
 * every row all day would compete with it. They stay in the DOM rather than
 * being mounted on hover, so Tab still reaches them. A hidden control is a
 * control a keyboard cannot use.
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

  return (
    <div
      className={cn(
        "group/chat flex h-7 w-full items-center rounded-[var(--radius-md)] pr-1 pl-5",
        "transition-colors duration-[var(--dur-fast)] hover:duration-0",
        current ? "bg-accent-subtle" : "hover:bg-surface-hover",
      )}
    >
      <button
        type="button"
        onClick={() => {
          /* Selecting a conversation means wanting to read it: the row also
             brings the Agent view forward, and drops the sheet or popover the
             rail was being shown in, so one tap does the whole job. */
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

      <div
        className={cn(
          "flex w-0 items-center overflow-hidden opacity-0",
          "transition-opacity duration-[var(--dur-fast)] motion-reduce:transition-none",
          "group-hover/chat:w-auto group-hover/chat:opacity-100",
          "group-focus-within/chat:w-auto group-focus-within/chat:opacity-100",
        )}
      >
        <RowAction
          label="Archive this chat"
          onClick={() => {
            void agent.archiveChat(chat.id).then(() => {
              toast.success("Chat archived", {
                description: chat.title,
                action: {
                  label: "Undo",
                  onClick: () => void agent.unarchiveChat(chat.id),
                },
              });
            });
          }}
        >
          <Archive strokeWidth={1.5} />
        </RowAction>
        <RowAction label="Delete this chat" destructive onClick={onDelete}>
          <Trash2 strokeWidth={1.5} />
        </RowAction>
      </div>
    </div>
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

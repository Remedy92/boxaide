"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgent } from "@/lib/hooks/use-agent";
import { useApp } from "@/lib/hooks/use-app-state";
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
  const app = useApp();
  const recent = agent.chats.slice(0, RECENT);
  const rest = Math.max(agent.chats.length - recent.length, 0);

  if (agent.connection === "unsupported") return null;

  return (
    <div className="space-y-px">
      {recent.length === 0 && (
        <p className="px-2 py-1 text-[12px] leading-4 text-fg-tertiary">
          No chats yet.
        </p>
      )}
      {recent.map((chat) => (
        <button
          key={chat.id}
          type="button"
          onClick={() => {
            /* Selecting a conversation means wanting to read it: the row also
               brings the Agent view forward, and drops the sheet or popover the
               rail was being shown in, so one tap does the whole job. */
            onNavigate?.();
            app.setView("agent");
            void agent.openChat(chat.id);
          }}
          aria-current={chat.id === agent.chat?.id ? "true" : undefined}
          title={chat.title}
          className={cn(
            "flex h-7 w-full items-center gap-2 rounded-[var(--radius-md)] py-0 pr-2 pl-5 text-left",
            "transition-colors duration-[var(--dur-fast)] hover:duration-0",
            chat.id === agent.chat?.id
              ? "bg-accent-subtle text-accent"
              : "text-fg-secondary hover:bg-surface-hover hover:text-fg",
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] leading-[18px]",
              chat.id === agent.chat?.id && "font-medium",
            )}
          >
            {chat.title}
          </span>
        </button>
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
    </div>
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

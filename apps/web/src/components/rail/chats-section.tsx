"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgent } from "@/lib/hooks/use-agent";
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

export function ChatsSection({ onOpenAll }: { onOpenAll: () => void }) {
  const agent = useAgent();
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
          onClick={() => void agent.openChat(chat.id)}
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

/** The header button that starts a conversation. Lives on the section label. */
export function NewChatButton() {
  const agent = useAgent();
  if (agent.connection === "unsupported") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="New chat"
          onClick={() => void agent.newChat()}
        >
          <Plus className="size-3.5" strokeWidth={1.5} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>New chat</TooltipContent>
    </Tooltip>
  );
}

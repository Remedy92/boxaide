"use client";

import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes } from "@/components/rail/chats-section";
import { listAgentChats } from "@/lib/api/endpoints";
import { useAgent } from "@/lib/hooks/use-agent";
import { useApp } from "@/lib/hooks/use-app-state";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { AgentChat } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Every conversation, and the only place the archived ones are listed.
 *
 * The rail shows five and this shows the rest, which is what keeps one sidebar
 * workable: the list a user scans daily is short, and the list they search
 * occasionally is complete.
 *
 * Archived rows are whole conversations the user has put away. Every message
 * is still there, so the row opens like any other and Unarchive puts it back
 * in the rail. Delete is the only control here that destroys anything.
 *
 * A row marked trimmed lost its messages to a limit rather than to a click:
 * either its own turn cap, or the storage budget, which empties archived chats
 * before live ones. The mark is there so an empty conversation is never a
 * surprise.
 */
export function ChatsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open) return null;
  return <ChatsDialogBody open={open} onOpenChange={onOpenChange} />;
}

function ChatsDialogBody({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const agent = useAgent();
  const app = useApp();
  const ctx = useApiCtx();
  const [query, setQuery] = React.useState("");
  const [archived, setArchived] = React.useState<AgentChat[]>([]);
  const [showArchived, setShowArchived] = React.useState(false);

  /* Below 760px this dialog is opened from the rail sheet, which stays mounted
     behind it. Picking a chat has to take that down too, or closing the dialog
     drops the reader straight back onto the rail.

     A tick later, not in this commit: closing both layers at once leaves focus
     on <body>, because the row this dialog hands focus back to goes away in the
     same breath. One tick apart, each layer restores focus to the control that
     opened it and the keyboard ends up on the sidebar button. A timer rather
     than a frame — a frame never comes in a background tab. */
  const leave = React.useCallback(() => {
    app.setView("agent");
    onOpenChange(false);
    window.setTimeout(() => {
      app.setRailSheetOpen(false);
      app.setRailOverlay(false);
    }, 0);
  }, [app, onOpenChange]);

  /* The archived list is fetched here rather than carried in the provider: it
     is read in one dialog, it can be long, and nothing in the rail needs it. */
  const loadArchived = React.useCallback(() => {
    const abort = new AbortController();
    void listAgentChats({ ...ctx, signal: abort.signal }, true)
      .then((list) => setArchived(list.chats.filter((chat) => chat.archivedAt)))
      .catch(() => setArchived([]));
    return () => abort.abort();
  }, [ctx]);

  React.useEffect(() => loadArchived(), [loadArchived, agent.chats]);

  const needle = query.trim().toLowerCase();
  const match = (chat: AgentChat) =>
    needle.length === 0 || chat.title.toLowerCase().includes(needle);
  const live = agent.chats.filter(match);
  const gone = archived.filter(match);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>All chats</DialogTitle>
          <DialogDescription>
            Pick up a conversation, or clear out the ones you are done with.
          </DialogDescription>
        </DialogHeader>
      <DialogBody>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                aria-hidden="true"
                strokeWidth={1.5}
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-tertiary"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search chats"
                aria-label="Search chats"
                className="pl-8"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void agent.newChat();
                leave();
              }}
            >
              <Plus className="size-3.5" strokeWidth={1.5} />
              New
            </Button>
          </div>

          <div className="pane-scroll max-h-[46vh] min-h-0 space-y-px overflow-y-auto">
            {live.length === 0 && (
              <p className="px-1 py-2 text-[12px] leading-4 text-fg-tertiary">
                {needle ? "No chats match." : "No chats yet."}
              </p>
            )}
            {live.map((chat) => (
              <div
                key={chat.id}
                className={cn(
                  "group flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5",
                  chat.id === agent.chat?.id
                    ? "bg-accent-subtle"
                    : "hover:bg-surface-hover",
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    /* Same as the rail rows: picking a conversation also
                       brings the Agent view forward. */
                    void agent.openChat(chat.id);
                    leave();
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <span
                    className={cn(
                      "block truncate text-[13px] leading-[18px]",
                      chat.id === agent.chat?.id ? "text-accent" : "text-fg",
                    )}
                  >
                    {chat.title}
                  </span>
                  <span className="block text-[11px] leading-4 text-fg-tertiary">
                    {when(chat.updatedAt)} · {chat.turns}{" "}
                    {chat.turns === 1 ? "message" : "messages"}
                    {chat.trimmedAt ? " · trimmed" : ""}
                  </span>
                </button>
                <RowAction
                  label="Archive this chat"
                  onClick={() => void agent.archiveChat(chat.id)}
                >
                  <Archive className="size-3.5" strokeWidth={1.5} />
                </RowAction>
                <RowAction
                  label="Delete this chat"
                  onClick={() => void agent.removeChat(chat.id)}
                >
                  <Trash2 className="size-3.5" strokeWidth={1.5} />
                </RowAction>
              </div>
            ))}

            {gone.length > 0 && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowArchived((prev) => !prev)}
                  aria-expanded={showArchived}
                  className="flex w-full items-center gap-1.5 border-t border-border px-1 pt-2 text-left text-[12px] leading-4 text-fg-tertiary hover:text-fg-secondary"
                >
                  <ChevronRight
                    aria-hidden="true"
                    strokeWidth={1.5}
                    className={cn(
                      "size-3 shrink-0 transition-transform duration-[var(--dur-fast)] motion-reduce:transition-none",
                      showArchived && "rotate-90",
                    )}
                  />
                  Archived · {gone.length}
                  <span className="ml-auto">put away, messages kept</span>
                </button>
                {showArchived &&
                  gone.map((chat) => (
                    <div
                      key={chat.id}
                      className="group flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-surface-hover"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          /* Opening an archived chat is the user coming back
                             to it, so the server takes it out of the archive
                             in the same step and the rail has it again. */
                          void agent.openChat(chat.id);
                          leave();
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate text-[13px] leading-[18px] text-fg">
                          {chat.title}
                        </span>
                        <span className="block text-[11px] leading-4 text-fg-tertiary">
                          Archived {when(chat.archivedAt ?? chat.updatedAt)} ·{" "}
                          {chat.turns} {chat.turns === 1 ? "message" : "messages"}
                          {chat.trimmedAt ? " · trimmed" : ""}
                        </span>
                      </button>
                      <RowAction
                        label="Unarchive this chat"
                        onClick={() => void agent.unarchiveChat(chat.id)}
                      >
                        <ArchiveRestore className="size-3.5" strokeWidth={1.5} />
                      </RowAction>
                      <RowAction
                        label="Delete this chat"
                        onClick={() => void agent.removeChat(chat.id)}
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.5} />
                      </RowAction>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {agent.storage.budget > 0 && (
            <div className="space-y-1.5 border-t border-border pt-3">
              <div className="flex items-center justify-between text-[12px] leading-4 text-fg-secondary tabular-nums">
                <span>
                  {agent.storage.chats + agent.storage.archived} chats ·{" "}
                  {formatBytes(agent.storage.bytes)}
                </span>
                <span>of {formatBytes(agent.storage.budget)}</span>
              </div>
              <div
                className="h-1 w-full overflow-hidden rounded-full bg-surface-hover"
                role="img"
                aria-label={`${formatBytes(agent.storage.bytes)} of ${formatBytes(agent.storage.budget)} used`}
              >
                <div
                  className="h-full bg-accent"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round((agent.storage.bytes / agent.storage.budget) * 100),
                    )}%`,
                  }}
                />
              </div>
              <p className="text-[11px] leading-4 text-fg-tertiary">
                Past this, old chats are trimmed: the title and date stay, the
                messages go. Archived chats are trimmed first.
              </p>
            </div>
          )}
      </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
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
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Short, relative, and never more precise than the reader needs. */
function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

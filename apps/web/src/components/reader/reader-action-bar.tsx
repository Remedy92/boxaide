"use client";

import * as React from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Forward,
  Mail,
  MailOpen,
  MoreHorizontal,
  Reply,
  ReplyAll,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { canMoveOutOf } from "@/lib/dnd/message-drag";
import { useFolders } from "@/lib/hooks/use-folders";
import { moveDestinations } from "@/lib/hooks/use-move";
import { copyToClipboard } from "@/lib/utils";
import type { MailMessage } from "@/lib/types";

/**
 * §6.4.1. Only these controls, because these are the only mutations the API
 * has: send (reply / reply all / forward), mark read, archive, and move to a
 * named folder. There is no star, snooze or label anywhere behind this bar, so
 * none is drawn, not even greyed out.
 *
 * Delete is not a button here either, though the API now has it. It is a move
 * to Trash, it is on the row's right-click menu and on `#`, and a bar this
 * narrow earns its calm by not putting a bin next to Reply.
 */
export function ReaderActionBar({
  message,
  narrow,
  hasPrevious,
  hasNext,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onToggleRead,
  onArchive,
  onMove,
  onPrevious,
  onNext,
}: {
  message: MailMessage | null;
  narrow: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onBack: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onToggleRead: () => void;
  onArchive: () => void;
  /** The mailbox path, as listFolders spells it. */
  onMove: (folder: string) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const [source, setSource] = React.useState<"text" | "html" | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const seen = message?.seen ?? false;
  const disabled = !message;

  /* Folders are per mailbox, and the mailbox is the open message's own rather
     than `app.account`, which reads "all" in the unified inbox. /api/folders
     answers "all" with a grouped shape now, but this menu wants one mailbox's
     flat list and knows exactly which mailbox that is. Asked for only while the
     menu is open, so reading mail costs no folder LIST at all, and the answer
     is cached for five minutes after that. */
  const folders = useFolders(menuOpen && message ? message.accountId : "");
  const destinations = moveDestinations(folders.data, message?.folder);
  /* A draft has no destinations at all: the server guards Drafts in both
     directions. Saying "no other folder" over a mailbox full of them would be
     a lie. */
  const stuckInDrafts =
    message !== null &&
    folders.data !== undefined &&
    !canMoveOutOf(message.folder, folders.data);

  const copy = async (value: string, label: string) => {
    const ok = await copyToClipboard(value);
    toast[ok ? "success" : "warning"](ok ? `Copied ${label}` : "Press ⌘C to copy");
  };

  return (
    <div className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-1 border-b border-border-subtle bg-surface-2 px-3">
      {narrow && (
        <Button
          type="button"
          variant="ghost"
          className="h-11 min-w-11"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" strokeWidth={1.5} />
          Inbox
        </Button>
      )}

      <Button type="button" variant="ghost" disabled={disabled} onClick={onReply}>
        <Reply className="size-4" strokeWidth={1.5} />
        Reply
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reply all"
            disabled={disabled}
            onClick={onReplyAll}
          >
            <ReplyAll className="size-4" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reply all</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Forward"
            disabled={disabled}
            onClick={onForward}
          >
            <Forward className="size-4" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Forward</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={seen ? "Mark unread" : "Mark read"}
            disabled={disabled}
            onClick={onToggleRead}
          >
            {seen ? (
              <MailOpen className="size-4" strokeWidth={1.5} />
            ) : (
              <Mail className="size-4" strokeWidth={1.5} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{seen ? "Mark unread" : "Mark read"}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Archive"
            disabled={disabled}
            onClick={onArchive}
          >
            <Archive className="size-4" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Archive (e)</TooltipContent>
      </Tooltip>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="More message actions"
            disabled={disabled}
          >
            <MoreHorizontal className="size-4" strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!message}>
              Move to folder
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[320px] w-64 overflow-y-auto">
              {folders.isPending ? (
                <DropdownMenuItem disabled>Loading folders…</DropdownMenuItem>
              ) : folders.isError ? (
                <DropdownMenuItem disabled>
                  Could not load this mailbox&rsquo;s folders
                </DropdownMenuItem>
              ) : destinations.length === 0 ? (
                <DropdownMenuItem disabled>
                  {stuckInDrafts
                    ? "A draft cannot be moved out of Drafts"
                    : "No other folder on this mailbox"}
                </DropdownMenuItem>
              ) : (
                destinations.map((folder) => (
                  <DropdownMenuItem
                    key={folder.path}
                    onSelect={() => onMove(folder.path)}
                  >
                    {folder.path}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            disabled={!message?.messageId}
            onSelect={() =>
              message?.messageId && void copy(message.messageId, "message ID")
            }
          >
            {message?.messageId
              ? "Copy message ID"
              : "This message has no Message-ID"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => message && void copy(message.id, "Boxaide ID")}
          >
            Copy Boxaide ID
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSource("text")}>
            View plain text source
          </DropdownMenuItem>
          {message?.bodyHtml && (
            <DropdownMenuItem onSelect={() => setSource("html")}>
              View HTML source
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Previous message"
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        <ChevronLeft className="size-4" strokeWidth={1.5} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Next message"
        disabled={!hasNext}
        onClick={onNext}
      >
        <ChevronRight className="size-4" strokeWidth={1.5} />
      </Button>

      {/* The HTML source is shown ESCAPED, as monospace text. The capability is
          made visible without ever being executed — React escapes the string
          child, and nothing here touches innerHTML. */}
      <Dialog open={source !== null} onOpenChange={(open) => !open && setSource(null)}>
        <DialogContent className="max-w-[720px]">
          <DialogHeader>
            <DialogTitle>
              {source === "html" ? "HTML source" : "Plain text source"}
            </DialogTitle>
            <DialogDescription>
              {source === "html"
                ? "The raw source, shown as escaped text. The reader renders it sanitised in a sandboxed frame."
                : "The bodyText the server returned, verbatim."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <pre className="rounded-[var(--radius-md)] bg-surface-0 p-3 font-mono text-[13px] whitespace-pre-wrap text-fg-secondary">
              {source === "html" ? (message?.bodyHtml ?? "") : (message?.bodyText ?? "")}
            </pre>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

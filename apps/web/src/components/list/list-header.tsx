"use client";

import * as React from "react";
import { MailOpen, Menu, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp, useSearchQuery } from "@/lib/hooks/use-app-state";
import { useFolders } from "@/lib/hooks/use-folders";

const ALL = "all";
const NO_FOLDER = "__inbox__";
const FOLDER_NOTE_ID = "mailmux-folder-filter-note";

/**
 * §6.3 header. The folder select is disabled while a search is running, with
 * copy that says why: routes.ts never forwards `folder` to searchMessages, so
 * search always runs against Inbox and a folder-scoped search control would be
 * a control that does nothing.
 */
export function ListHeader({
  fetching,
  onRefresh,
  onOpenRail,
  showRailButton,
}: {
  fetching: boolean;
  onRefresh: () => void;
  onOpenRail: () => void;
  showRailButton: boolean;
}) {
  const app = useApp();
  const rawQuery = useSearchQuery();
  const accounts = useAccounts();
  // A local ref, registered with the shell in an effect. Passing the context's
  // callback straight to `ref` would make every later `app.*` read count as a
  // ref access during render.
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const register = app.registerSearchInput;
  React.useEffect(() => {
    register(inputRef.current);
    return () => register(null);
  }, [register]);

  const folders = useFolders(app.account);
  const searching = app.searching;
  const list = accounts.data ?? [];
  const folderReason = searching
    ? "Search always runs against Inbox."
    : app.account === ALL
      ? "Pick one mailbox first, this picker filters one mailbox at a time."
      : null;

  return (
    <div className="sticky top-0 z-10 bg-surface-1">
      {/* Two rows on purpose. One row cannot hold search plus two selects plus
          two icon buttons inside a 380px pane: `flex-1` collapsed the search
          field to 89px, which truncated its own placeholder. Search owns the
          first row; the filters and actions sit under it. */}
      <div className="flex h-11 items-center gap-2 px-3">
        {showRailButton && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open mailboxes and folders"
            onClick={onOpenRail}
          >
            <Menu className="size-4" strokeWidth={1.5} />
          </Button>
        )}

        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-tertiary"
            strokeWidth={1.5}
          />
          <Input
            ref={inputRef}
            type="search"
            value={rawQuery}
            onChange={(event) => app.setRawQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                app.setRawQuery("");
                event.currentTarget.blur();
              }
            }}
            placeholder="Search mail"
            aria-label="Search mail"
            className="bg-surface-2 pr-7 pl-7 [&::-webkit-search-cancel-button]:hidden"
          />
          {rawQuery && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => app.setRawQuery("")}
              className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-tertiary hover:bg-surface-hover hover:text-fg"
            >
              <X className="size-3.5" strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>

      <div className="flex h-9 items-center gap-1.5 border-b border-border-subtle px-3 pb-1.5">
        <Select
          value={app.account}
          onValueChange={(value) => app.setAccount(value)}
        >
          {/* Not `border-transparent bg-transparent`: at rest that measures
              1.00:1 against the header, so the combobox is indistinguishable
              from static text until hover — and hover only reaches 1.49 (1.4.11). */}
          <SelectTrigger
            size="sm"
            aria-label="Filter by mailbox"
            className="h-7 min-w-0 flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All mailboxes</SelectItem>
            {list.map((account) => (
              <SelectItem key={account.id} value={account.alias}>
                {account.alias}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* When the folder filter cannot apply, the control is replaced by a
            focusable aria-disabled stand-in rather than a `disabled` Select.
            A disabled Radix trigger leaves the tab order, and the tooltip that
            carries the only explanation is then hover-only — keyboard and
            screen-reader users would get a dead control with no stated reason.
            The reason is bound with aria-describedby, the same pattern the
            rail's disabled nav rows already use. */}
        {folderReason ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-disabled="true"
                  aria-label="Filter by folder"
                  aria-describedby={FOLDER_NOTE_ID}
                  className="h-7 min-w-0 flex-1 cursor-not-allowed justify-start text-fg-disabled"
                >
                  Folder
                </Button>
              </TooltipTrigger>
              <TooltipContent>{folderReason}</TooltipContent>
            </Tooltip>
            <span id={FOLDER_NOTE_ID} className="sr-only">
              {folderReason}
            </span>
          </>
        ) : (
          <Select
            value={app.folder ?? NO_FOLDER}
            onValueChange={(value) =>
              app.setFolder(value === NO_FOLDER ? undefined : value)
            }
          >
            <SelectTrigger
              size="sm"
              aria-label="Filter by folder"
              className="h-7 min-w-0 flex-1"
            >
              <SelectValue placeholder="Folder" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_FOLDER}>Inbox</SelectItem>
              {(folders.data ?? []).map((folder) => (
                <SelectItem key={folder.path} value={folder.path}>
                  {folder.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Show unread only"
              aria-pressed={app.unreadOnly}
              onClick={() => app.setUnreadOnly(!app.unreadOnly)}
              /* ml-auto starts the trailing action group, so the two selects
                 take the free space instead of the gap between them. */
              className={`ml-auto shrink-0 ${
                app.unreadOnly ? "bg-accent-subtle text-accent" : ""
              }`}
            >
              <MailOpen className="size-4" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          {/* GET /api/messages/search takes no `unread` parameter, so this
              cannot filter search results. Turning it on leaves the search
              instead of sitting lit over results it does not affect. */}
          <TooltipContent>
            {searching ? "Unread only — leaves search" : "Unread only"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh the message list"
              aria-busy={fetching || undefined}
              onClick={onRefresh}
            >
              <RefreshCw
                className={`size-4 ${fetching ? "mailmux-spin" : ""}`}
                strokeWidth={1.5}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>

      {searching && (
        <p className="flex h-6 items-center border-b border-border-subtle px-3 text-[12px] text-fg-tertiary">
          Searching Inbox in{" "}
          {app.account === ALL ? "all mailboxes" : app.account}
        </p>
      )}
    </div>
  );
}

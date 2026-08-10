"use client";

import * as React from "react";
import { Menu, Plus, RefreshCw } from "lucide-react";
import { DraftRow } from "@/components/drafts/draft-row";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import { useDrafts } from "@/lib/hooks/use-drafts";

const ALL = "all";

/**
 * The Drafts pane.
 *
 * Drafts are not a folder filter — `GET /api/drafts` is its own endpoint with
 * its own per-mailbox fan-out — so this is a sibling of the message list rather
 * than a mode of it. The mailbox filter is shared with the inbox so switching
 * views keeps you in the same mailbox.
 */
export function DraftsList({
  onOpenRail,
  showRailButton,
}: {
  onOpenRail: () => void;
  showRailButton: boolean;
}) {
  const app = useApp();
  const accounts = useAccounts();
  const list = accounts.data ?? [];
  const drafts = useDrafts(app.account);

  const rows = drafts.drafts;
  const selectedId = app.selectedDraft?.draftId ?? null;
  const activeId = selectedId ?? rows[0]?.id ?? null;
  const showRail = app.account === ALL && list.length > 1;

  const rowRefs = React.useRef(new Map<string, HTMLLIElement>());
  const registerRow = React.useCallback(
    (id: string, node: HTMLLIElement | null) => {
      if (node) rowRefs.current.set(id, node);
      else rowRefs.current.delete(id);
    },
    [],
  );

  React.useEffect(() => {
    if (!selectedId) return;
    rowRefs.current.get(selectedId)?.scrollIntoView({
      block: "nearest",
      behavior: app.reducedMotion ? "auto" : "smooth",
    });
  }, [app.reducedMotion, selectedId]);

  const selectDraft = app.selectDraft;

  let body: React.ReactNode;
  if (list.length === 0) {
    body = (
      <Empty>
        Connect a mailbox and its drafts appear here.
      </Empty>
    );
  } else if (rows.length === 0 && drafts.isPending) {
    body = <ListSkeleton rows={5} />;
  } else if (drafts.isError) {
    body = (
      <Empty action={<Button type="button" size="sm" onClick={drafts.refetch}>Try again</Button>}>
        {friendlyError(drafts.errors[0]?.error ?? "")}
      </Empty>
    );
  } else if (rows.length === 0) {
    body = (
      <Empty
        action={
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={list.length === 0}
            onClick={() => app.openCompose({ account: list[0]?.alias })}
          >
            Start one
          </Button>
        }
      >
        No drafts in{" "}
        {app.account === ALL ? "any mailbox" : app.account}.
      </Empty>
    );
  } else {
    body = (
      <ul
        role="listbox"
        aria-label="Drafts"
        aria-busy={drafts.isFetching || undefined}
        className="list-none"
      >
        {rows.map((draft) => (
          <DraftRow
            key={draft.id}
            draft={draft}
            selected={selectedId === draft.id}
            active={activeId === draft.id}
            showRail={showRail}
            onSelect={selectDraft}
            registerRow={registerRow}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-10 bg-surface-1">
        <div className="flex h-11 items-center gap-1.5 border-b border-border-subtle px-3">
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

          <h2 className="mr-1 text-[13px] font-medium text-fg">Drafts</h2>

          <Select value={app.account} onValueChange={app.setAccount}>
            <SelectTrigger
              size="sm"
              aria-label="Filter drafts by mailbox"
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

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="New draft"
                disabled={list.length === 0}
                onClick={() => app.openCompose({ account: list[0]?.alias })}
              >
                <Plus className="size-4" strokeWidth={1.5} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New draft</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh drafts"
                aria-busy={drafts.isFetching || undefined}
                onClick={drafts.refetch}
              >
                <RefreshCw
                  className={`size-4 ${drafts.isFetching ? "mailmux-spin" : ""}`}
                  strokeWidth={1.5}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {drafts.isFetching && rows.length > 0 && (
        <div aria-hidden="true" className="h-0.5 shrink-0 overflow-hidden">
          <div className="mailmux-progress h-full bg-accent" />
        </div>
      )}

      {/* A partial fan-out failure is not an error state: the mailboxes that
          answered still show their drafts, and this names the ones that did
          not — the same contract the message list's errors[] banner has. */}
      <div role="status" aria-live="polite">
        {!drafts.isError && drafts.errors.length > 0 && (
          <p className="bg-warning-bg px-3 py-2 text-[12px] leading-4 text-warning">
            {drafts.errors.map((entry) => entry.account).join(", ")} did not
            answer, so their drafts are missing.
          </p>
        )}
      </div>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}

/** One quiet sentence, centred, with at most one action. */
function Empty({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="max-w-[240px] text-center">
        <p className="text-[13px] leading-[18px] text-fg-tertiary">{children}</p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

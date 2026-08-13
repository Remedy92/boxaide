"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Menu, RefreshCw } from "lucide-react";
import { ConnectionStateBlock } from "@/components/list/list-empty";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { CampaignList } from "@/components/outreach/campaign-list";
import { OutboxQueueRow } from "@/components/outreach/outbox-row";
import { SuppressionPanel } from "@/components/outreach/suppression-panel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useApp, type OutreachTab } from "@/lib/hooks/use-app-state";
import { useConnection, useMeta } from "@/lib/hooks/use-connection";
import { useOutbox } from "@/lib/hooks/use-outreach";
import { useSettings } from "@/lib/hooks/use-settings";
import { cn } from "@/lib/utils";

const TABS: Array<{ id: OutreachTab; label: string }> = [
  { id: "queue", label: "Queue" },
  { id: "campaigns", label: "Campaigns" },
  { id: "suppression", label: "Suppressed" },
];

/**
 * The Outreach middle column.
 *
 * Three lists, one column, because they are three views of one thing: what an
 * agent wants to send, who it is sending to, and who must never be written to.
 * Only the queue drives the reading pane — the other two are self-contained,
 * which is why switching away from Queue closes the pane rather than leaving an
 * Approve button beside a list it is not about.
 */
export function OutreachList({
  onOpenRail,
  showRailButton,
}: {
  onOpenRail: () => void;
  showRailButton: boolean;
}) {
  const app = useApp();
  const queryClient = useQueryClient();
  const connection = useConnection();
  const meta = useMeta();
  const settings = useSettings();
  const tab = app.outreachTab;

  // The queue is pending rows and nothing else: a row that was already decided
  // cannot be decided again, and listing one beside an Approve button would
  // offer a decision the server answers with a 400.
  const queue = useOutbox("pending", tab === "queue");
  const rows = React.useMemo(() => queue.data ?? [], [queue.data]);

  const selectedId = app.selectedOutbox;
  const activeId = selectedId ?? rows[0]?.id ?? null;
  const selectOutbox = app.selectOutbox;

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

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["outreach-outbox"] });
    void queryClient.invalidateQueries({ queryKey: ["outreach-campaigns"] });
    void queryClient.invalidateQueries({ queryKey: ["outreach-suppression"] });
    void queryClient.invalidateQueries({ queryKey: ["outreach-badge"] });
  }, [queryClient]);

  const blocked = connection.kind !== "ok";

  let body: React.ReactNode;
  if (blocked) {
    /* A disabled query never resolves, so the pane would skeleton forever. */
    body = (
      <ConnectionStateBlock
        connection={connection}
        tokenHint={meta.data?.tokenHint}
        baseUrl={settings.baseUrl}
        handlers={{
          openSettings: (focus) => app.openSettings(focus ?? null),
          retry: refresh,
        }}
      />
    );
  } else if (tab === "campaigns") {
    body = <CampaignList />;
  } else if (tab === "suppression") {
    body = <SuppressionPanel />;
  } else if (queue.isError) {
    body = (
      <div className="px-6 py-10 text-center">
        <p className="text-[13px] leading-[18px] text-fg-tertiary">
          {friendlyError(
            queue.error instanceof Error ? queue.error.message : queue.error,
          )}
        </p>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          onClick={() => void queue.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  } else if (rows.length === 0 && queue.isPending) {
    body = <ListSkeleton rows={5} />;
  } else if (rows.length === 0) {
    body = (
      <div className="px-6 py-10 text-center">
        <p className="text-[13px] leading-[18px] text-fg-tertiary">
          Nothing waiting. Mail an agent writes lands here first — nothing is
          sent until you approve it.
        </p>
      </div>
    );
  } else {
    body = (
      <ul
        role="listbox"
        aria-label="Emails waiting for approval"
        aria-busy={queue.isFetching || undefined}
        className="list-none"
      >
        {rows.map((row) => (
          <OutboxQueueRow
            key={row.id}
            row={row}
            selected={selectedId === row.id}
            active={activeId === row.id}
            onSelect={selectOutbox}
            registerRow={registerRow}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-10 bg-surface-1">
        <div className="flex h-11 items-center gap-1.5 px-3">
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

          {/* Pressed toggles, not an ARIA tablist: these are filters over one
              view, they share the pane and the keyboard map, and a real tablist
              owes the reader arrow-key navigation and a labelled tabpanel that
              this column does not have. Same idiom as the unread toggle. */}
          <div className="flex min-w-0 gap-1">
            {TABS.map((entry) => {
              const current = tab === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={current}
                  aria-label={
                    entry.id === "queue" && rows.length > 0
                      ? `Queue, ${rows.length} waiting for approval`
                      : undefined
                  }
                  onClick={() => app.setOutreachTab(entry.id)}
                  className={cn(
                    "h-7 rounded-[var(--radius-md)] px-2 text-[13px] leading-[18px]",
                    "transition-colors duration-[var(--dur-fast)] hover:duration-0",
                    current
                      ? "bg-accent-subtle font-medium text-accent"
                      : "text-fg-secondary hover:bg-surface-hover hover:text-fg",
                  )}
                >
                  {entry.label}
                  {entry.id === "queue" && rows.length > 0 && (
                    <span className="tnum ml-1 text-[11px] text-fg-tertiary">
                      {rows.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh outreach"
                aria-busy={queue.isFetching || undefined}
                className="ml-auto shrink-0"
                onClick={refresh}
              >
                <RefreshCw
                  className={`size-4 ${queue.isFetching ? "mailmux-spin" : ""}`}
                  strokeWidth={1.5}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
        <div className="border-b border-border-subtle" />
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {tab === "queue" && !queue.isFetching && rows.length > 0
          ? `${rows.length} ${rows.length === 1 ? "email" : "emails"} waiting for approval`
          : ""}
      </p>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}

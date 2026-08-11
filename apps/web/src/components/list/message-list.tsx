"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AccountErrorBanner } from "@/components/list/account-error-banner";
import { ListHeader } from "@/components/list/list-header";
import {
  ConnectionStateBlock,
  NoAccountsState,
  NoMessagesState,
  NoResultsState,
  RequestErrorState,
} from "@/components/list/list-empty";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { MessageRow } from "@/components/list/message-row";
import { Button } from "@/components/ui/button";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import { useConnection, useMeta } from "@/lib/hooks/use-connection";
import { usePrefetchMessage } from "@/lib/hooks/use-message";
import { useMessages } from "@/lib/hooks/use-messages";
import { useSettings } from "@/lib/hooks/use-settings";
import { DEFAULT_LIMIT } from "@/lib/constants";
import { hostLabel } from "@/lib/settings";

/**
 * §6.3. The list is capped at 200 rows by the server (`MAX_LIMIT`) and there is
 * no reachable `offset`, so there is no pagination and no virtualization: 200
 * fixed-height rows render fine, and a virtualizer would be a dependency and a
 * second source of truth for no capability the backend gains.
 */
export function MessageList({
  onOpenRail,
  showRailButton,
}: {
  onOpenRail: () => void;
  showRailButton: boolean;
}) {
  const app = useApp();
  const settings = useSettings();
  const accounts = useAccounts();
  const connection = useConnection();
  const meta = useMeta();
  const queryClient = useQueryClient();
  const prefetch = usePrefetchMessage();

  const messages = useMessages({
    account: app.account,
    folder: app.folder,
    unreadOnly: app.unreadOnly,
    q: app.query,
  });

  // Memoised so its identity is stable while the cache entry is: the row
  // handler map below and two effects key off it.
  const rows = React.useMemo(
    () => messages.data?.messages ?? [],
    [messages.data],
  );
  const errors = messages.data?.errors ?? [];
  const hasRows = rows.length > 0;
  const searching = app.query.trim().length > 0;

  /* Which mailbox a row came from, as its name.

     This replaces the 2px colour stripe that used to run down the left of every
     row. A stripe needs a legend the UI never had — the only way to learn that
     dusty-blue meant "work" was to notice the same dusty blue in the sidebar —
     and eight low-chroma greys are hard to tell apart at 2px anyway. The alias
     says it outright, costs no colour, and reads the same to a screen reader.

     Shown only in the unified view of more than one mailbox, which is the only
     place the answer varies between rows. */
  const showMailbox = app.account === "all" && (accounts.data?.length ?? 0) > 1;
  const aliasById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const account of accounts.data ?? []) map.set(account.id, account.alias);
    return map;
  }, [accounts.data]);

  /* ---- skeleton tiers, on the 300ms floor -------------------------- */
  const [waited, setWaited] = React.useState(0);
  React.useEffect(() => {
    if (!messages.isFetching) return;
    const timers = [
      setTimeout(() => setWaited(300), 300),
      setTimeout(() => setWaited(1000), 1000),
      setTimeout(() => setWaited(10_000), 10_000),
    ];
    return () => {
      timers.forEach(clearTimeout);
      setWaited(0);
    };
  }, [messages.isFetching]);

  /* ---- roving tabindex + scroll-into-view --------------------------- */
  const rowRefs = React.useRef(new Map<string, HTMLLIElement>());
  const selectedId = app.selected?.messageId ?? null;
  const activeId = selectedId ?? rows[0]?.id ?? null;

  React.useEffect(() => {
    if (!selectedId) return;
    const node = rowRefs.current.get(selectedId);
    node?.scrollIntoView({
      block: "nearest",
      behavior: app.reducedMotion ? "auto" : "smooth",
    });
  }, [app.reducedMotion, selectedId]);

  /* Every prop handed to MessageRow is stable across renders. Inline arrows
     gave React.memo on the row a new prop identity on every parent render — so
     all 200 rows re-rendered on every keystroke — and an unstable callback ref
     additionally made React detach and reattach every row's ref on every
     commit. The row closes over its own id; the parent hands over primitives. */
  const select = app.select;
  const registerRow = React.useCallback(
    (id: string, node: HTMLLIElement | null) => {
      if (node) rowRefs.current.set(id, node);
      else rowRefs.current.delete(id);
    },
    [],
  );

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["messages"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
  }, [queryClient]);

  // `connection.kind` decides, not the element: a JSX element is always
  // truthy, so testing the element itself would hide the list forever.
  const blocked = connection.kind !== "ok";
  const connectionBlock = (
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

  let body: React.ReactNode;
  if (blocked) {
    body = connectionBlock;
  } else if (accounts.data && accounts.data.length === 0) {
    body = <NoAccountsState onConnect={() => app.openDialog("connect")} />;
  } else if (messages.isError && !hasRows) {
    body = <RequestErrorState error={messages.error} onRetry={refresh} />;
  } else if (!hasRows && messages.isPending) {
    body =
      waited >= 300 ? (
        <div>
          <ListSkeleton rows={Math.min(DEFAULT_LIMIT, 8)} />
          {waited >= 1000 && (
            <p className="flex items-center gap-2 px-3 text-[12px] text-fg-tertiary">
              Connecting to {hostLabel(settings.baseUrl)}…
              {waited >= 10_000 && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-4 px-0"
                  onClick={() =>
                    void queryClient.cancelQueries({ queryKey: ["messages"] })
                  }
                >
                  Cancel
                </Button>
              )}
            </p>
          )}
        </div>
      ) : null;
  } else if (!hasRows && searching) {
    body = (
      <NoResultsState
        query={app.query.trim()}
        onClear={() => app.setRawQuery("")}
      />
    );
  } else if (!hasRows) {
    body = (
      <NoMessagesState
        unreadOnly={app.unreadOnly}
        folder={app.folder}
        onShowAll={() => {
          app.setUnreadOnly(false);
          app.setFolder(undefined);
        }}
      />
    );
  } else {
    body = (
      <ul
        role="listbox"
        aria-label="Messages"
        aria-busy={messages.isFetching || undefined}
        className="list-none"
      >
        {rows.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            selected={selectedId === message.id}
            active={activeId === message.id}
            compact={app.density === "compact"}
            mailbox={showMailbox ? aliasById.get(message.accountId) : undefined}
            registerRow={registerRow}
            onSelect={select}
            onPrefetch={prefetch}
          />
        ))}
      </ul>
    );
  }

  const total = app.account === "all" ? (accounts.data?.length ?? 0) : 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ListHeader
        fetching={messages.isFetching}
        onRefresh={refresh}
        onOpenRail={onOpenRail}
        showRailButton={showRailButton}
      />

      {/* A background refetch with rows on screen keeps the rows and shows a
          2px bar. Blanking to a skeleton on every filter change is the single
          biggest thing that makes a mail client feel slow. */}
      {messages.isFetching && hasRows && (
        <div
          aria-hidden="true"
          className="h-0.5 shrink-0 overflow-hidden bg-transparent"
        >
          <div className="mailmux-progress h-full bg-accent" />
        </div>
      )}

      <AccountErrorBanner errors={errors} total={total} onRetry={refresh} />

      {/* aria-busy on the listbox is not a status message and the 2px bar is
          aria-hidden, so without this a refresh is silent for a screen reader.
          Mounted unconditionally — a live region inserted at the same moment
          as its content is not announced by most AT. */}
      <p role="status" aria-live="polite" className="sr-only">
        {blocked
          ? ""
          : messages.isFetching
            ? "Loading messages…"
            : hasRows
              ? `${rows.length} ${rows.length === 1 ? "message" : "messages"}`
              : ""}
      </p>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}

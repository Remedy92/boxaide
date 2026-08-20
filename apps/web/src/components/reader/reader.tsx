"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { BrandGlyph, TechnicalDetails } from "@/components/atoms";
import { BodyText } from "@/components/reader/body-text";
import { HtmlBody } from "@/components/reader/html-body";
import { IdentityBlock } from "@/components/reader/identity-block";
import { InlineReply, type Draft } from "@/components/reader/inline-reply";
import { ReaderActionBar } from "@/components/reader/reader-action-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ApiError, friendlyError } from "@/lib/api/errors";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import { useMarkRead } from "@/lib/hooks/use-mark-read";
import { useMessage } from "@/lib/hooks/use-message";
import { useMessageNavigation } from "@/lib/hooks/use-selection";
import type { MailMessage } from "@/lib/types";

export function Reader() {
  const app = useApp();
  const accounts = useAccounts();
  const nav = useMessageNavigation();
  const markRead = useMarkRead();
  const queryClient = useQueryClient();
  /** In-memory drafts, keyed by Boxaide message id. Never localStorage —
      drafts are message content. */
  const drafts = React.useRef(new Map<string, Draft>());

  const selection = app.selected;
  const message = useMessage(selection?.accountId ?? null, selection?.messageId ?? null);

  /* Cache-then-network: the list row already carries from, subject, date,
     folder and accountId, so the header paints at 0ms and only the body waits. */
  const seed = nav.current;
  const full = message.data ?? null;
  const shown = React.useMemo<MailMessage | null>(
    () => (full ? full : seed ? ({ ...seed, bodyText: "" } as MailMessage) : null),
    [full, seed],
  );

  const account = React.useMemo(() => {
    if (!selection) return null;
    return (
      (accounts.data ?? []).find((entry) => entry.id === selection.accountId) ??
      null
    );
  }, [accounts.data, selection]);

  const toggleRead = React.useCallback(() => {
    if (!shown || !selection) return;
    markRead.mutate({
      accountId: selection.accountId,
      messageId: selection.messageId,
      seen: !shown.seen,
    });
  }, [markRead, selection, shown]);

  if (!selection) {
    return (
      <div
        id="mailmux-reader"
        className="flex h-full items-center justify-center px-5"
      >
        <div className="text-center">
          <BrandGlyph size={20} className="mx-auto text-fg-disabled" />
          <p className="mt-3 text-[13px] leading-[18px] text-fg-tertiary">
            Pick a message, or press j to start.
          </p>
        </div>
      </div>
    );
  }

  const notFound =
    message.error instanceof ApiError && message.error.status === 404;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ReaderActionBar
        message={full}
        narrow={app.narrow}
        hasPrevious={nav.hasPrevious}
        hasNext={nav.hasNext}
        onBack={app.clearSelection}
        onReply={() => (full ? app.requestReply("reply") : undefined)}
        onReplyAll={() => (full ? app.requestReply("replyAll") : undefined)}
        onForward={() => (full ? app.requestReply("forward") : undefined)}
        onToggleRead={toggleRead}
        onPrevious={nav.previous}
        onNext={nav.next}
      />

      {/* tabIndex -1 so `o` / Enter can move focus here programmatically. It is
          not a tab stop: §6.1 gives the reader exactly one, the first
          action-bar button. */}
      <div
        id="mailmux-reader"
        tabIndex={-1}
        className="pane-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-10 focus:outline-none"
      >
        {message.isError && !notFound && (
          // role="alert": the message the user asked for did not arrive and
          // focus is still on the row or key that asked for it.
          <div role="alert" className="mt-6 rounded-[var(--radius-md)] bg-danger-bg p-3">
            <p className="flex items-center gap-2 text-[13px] text-danger">
              <CircleAlert aria-hidden="true" className="size-4" strokeWidth={1.5} />
              {friendlyError(
                message.error instanceof Error
                  ? message.error.message
                  : message.error,
              )}
            </p>
            <TechnicalDetails
              raw={
                message.error instanceof Error
                  ? message.error.message
                  : message.error
              }
            />
            <Button
              type="button"
              variant="secondary"
              className="mt-2"
              onClick={() => void message.refetch()}
            >
              Retry
            </Button>
          </div>
        )}

        {notFound ? (
          <div role="alert" className="mt-6">
            <p className="text-[13px] leading-[18px] font-medium text-fg">
              That message is gone. It may have been moved or deleted on the
              server.
            </p>
            <Button
              type="button"
              className="mt-3"
              onClick={() => {
                // Refetching the single-message query would do nothing here —
                // clearing the selection disables it. The stale row is in the
                // *listing*, so that is what has to be invalidated.
                app.clearSelection();
                void queryClient.invalidateQueries({ queryKey: ["messages"] });
              }}
            >
              Refresh the list
            </Button>
          </div>
        ) : shown ? (
          <article className="mx-auto max-w-[calc(var(--reader-measure)+2rem)] pt-5">
            {/* h2, not h1: the page's h1 is the app name in AppShell, which is
                present at every width and in every state. The subject is still
                the largest text on the page — the level is semantics, not size. */}
            <h2
              className="title-15 mb-3 text-fg"
              title={shown.subject}
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {shown.subject}
            </h2>

            <IdentityBlock message={shown} alias={account?.alias ?? null} />

            {full ? (
              /* HTML mail renders sanitised in a sandboxed frame (§6.4.6);
                 text-only mail keeps the plain-text reader. */
              full.bodyHtml ? (
                /* Keyed: without it React keeps the instance across a
                   selection change and the "Load images" consent leaks into
                   the next sender's mail. */
                <HtmlBody
                  key={full.id}
                  html={full.bodyHtml}
                  text={full.bodyText}
                />
              ) : (
                <BodyText text={full.bodyText} hasHtml={false} />
              )
            ) : (
              <div className="mt-5 space-y-2">
                <Skeleton className="h-3 w-[90%]" />
                <Skeleton className="h-3 w-[78%]" />
                <Skeleton className="h-3 w-[60%]" />
              </div>
            )}

            {full && (
              <InlineReply
                // Remounting on a new message, or on a fresh r / a / f press,
                // is what lets the composer initialise from props with no
                // state-syncing effect at all.
                key={`${full.id}:${app.replyRequest?.nonce ?? "idle"}`}
                message={full}
                account={account}
                initialMode={app.replyRequest?.mode ?? null}
                drafts={drafts}
              />
            )}
          </article>
        ) : (
          <div className="mt-6 space-y-2">
            <Skeleton className="h-4 w-[60%]" />
            <Skeleton className="h-3 w-[40%]" />
          </div>
        )}
      </div>
    </div>
  );
}

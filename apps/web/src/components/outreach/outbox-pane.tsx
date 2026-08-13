"use client";

import * as React from "react";
import { ArrowLeft, Check, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { BrandGlyph, Spinner } from "@/components/atoms";
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
import { friendlyError } from "@/lib/api/errors";
import { formatReaderDate, isoAttr, isoTitle } from "@/lib/format/date";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import { useOutbox } from "@/lib/hooks/use-outreach";
import { useDecideOutbox } from "@/lib/hooks/use-outreach-mutations";

/**
 * The approval pane: the whole email, exactly as it would go out, and the three
 * things a human can do about it.
 *
 * The body is plain text — outreach has no HTML bodies — and is rendered as
 * text, like every other piece of mail content in this app. The opt-out footer
 * is already part of it: the engine appended it when the row was queued, so
 * what is on screen is the message, not a preview of one.
 *
 * "Edit" is honest about what it is. No route rewrites a queued row, so editing
 * means taking the text into the composer and sending it yourself; the queued
 * copy is rejected once that send succeeds, so the same mail cannot also leave
 * through the engine.
 */
export function OutboxPane() {
  const app = useApp();
  const accounts = useAccounts();
  // Same query the list issues — React Query dedupes it, so this is a read of
  // the rows already on screen rather than a second request.
  const queue = useOutbox("pending", app.outreachTab === "queue");
  const decide = useDecideOutbox();
  const [confirmingReject, setConfirmingReject] = React.useState(false);

  const row = React.useMemo(
    () => (queue.data ?? []).find((entry) => entry.id === app.selectedOutbox) ?? null,
    [queue.data, app.selectedOutbox],
  );

  if (!row) {
    return (
      <div className="flex h-full items-center justify-center px-5">
        <div className="max-w-[260px] text-center">
          <BrandGlyph size={20} className="mx-auto text-fg-disabled" />
          <p className="mt-3 text-[13px] leading-[18px] text-fg-tertiary">
            {app.outreachTab === "queue"
              ? "Pick an email to read every word before it goes anywhere."
              : "The approval queue is under Queue."}
          </p>
        </div>
      </div>
    );
  }

  const alias =
    (accounts.data ?? []).find((account) => account.id === row.accountId)
      ?.alias ?? row.accountId;

  const approve = () => {
    decide.mutate(
      { outboxId: row.id, decision: "approve" },
      {
        onSuccess: () => {
          app.selectOutbox(null);
          toast.success(`Approved the email to ${row.to}`, {
            // Approval is not delivery: the engine spaces sends a minute apart
            // and stops at the daily cap, so it may go out later today.
            description: "It goes out with the next send, under the daily cap.",
          });
        },
        onError: (error) =>
          toast.error("Could not approve that email", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  const reject = () => {
    decide.mutate(
      { outboxId: row.id, decision: "reject" },
      {
        onSuccess: () => {
          setConfirmingReject(false);
          app.selectOutbox(null);
          toast.success("Rejected. It will not be sent.");
        },
        onError: (error) =>
          toast.error("Could not reject that email", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  const edit = () => {
    app.openCompose({
      account: alias,
      to: row.to,
      subject: row.subject,
      text: row.body,
      outboxId: row.id,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The reader's 44px action bar, so the two panes line up when the view
          changes under a fixed viewport. */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2">
        {app.narrow && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to the approval queue"
            onClick={() => app.selectOutbox(null)}
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
          </Button>
        )}

        <Button
          type="button"
          size="sm"
          disabled={decide.isPending}
          onClick={approve}
        >
          {decide.isPending ? <Spinner /> : <Check className="size-3.5" strokeWidth={1.5} />}
          Approve
        </Button>

        <Button type="button" size="sm" variant="secondary" onClick={edit}>
          <Pencil className="size-3.5" strokeWidth={1.5} />
          Edit…
        </Button>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={decide.isPending}
          onClick={() => setConfirmingReject(true)}
        >
          <X className="size-3.5" strokeWidth={1.5} />
          Reject
        </Button>
      </div>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-10">
        <article className="mx-auto max-w-[calc(var(--reader-measure)+2rem)] pt-5">
          {/* h2, not h1: the page's h1 is the app name in AppShell. */}
          <h2 className="title-15 text-fg">{row.subject}</h2>

          <dl className="mt-2 space-y-0.5 text-[13px] leading-[18px]">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-fg-tertiary">To</dt>
              <dd className="min-w-0 break-words text-fg">{row.to}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-fg-tertiary">From</dt>
              <dd className="min-w-0 break-words text-fg-secondary">{alias}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-fg-tertiary">Queued</dt>
              <dd className="min-w-0 text-fg-secondary">
                <time dateTime={isoAttr(row.createdAt)} title={isoTitle(row.createdAt)}>
                  {formatReaderDate(row.createdAt)}
                </time>
                {row.stepPosition !== null && (
                  <span className="text-fg-tertiary">
                    {" · "}step {row.stepPosition + 1}
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {/* The text as it will be sent, footer and all. Never markup. */}
          <p className="mt-5 text-[14px] leading-[22px] whitespace-pre-wrap text-fg">
            {row.body}
          </p>

          <p className="mt-6 border-t border-border-subtle pt-3 text-[12px] leading-[18px] text-fg-tertiary">
            An agent wrote this. Nothing was sent, and nothing will be until you
            approve it — there is no tool that lets an agent approve its own
            mail. The opt-out line is already in the body, and there are no
            tracking links in it.
          </p>
        </article>
      </div>

      <AlertDialog
        open={confirmingReject}
        onOpenChange={(next) => (next ? undefined : setConfirmingReject(false))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this email?</AlertDialogTitle>
            <AlertDialogDescription>
              It stays on record as rejected and can never be sent. If the
              campaign has a next step, that step is still queued later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                reject();
              }}
            >
              {decide.isPending && <Spinner />}
              {decide.isPending ? "Rejecting…" : "Reject"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

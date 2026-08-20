"use client";

import * as React from "react";
import { ChevronLeft, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { BrandGlyph, Field, Spinner, TechnicalDetails } from "@/components/atoms";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/api/errors";
import { formatReaderDate, isoAttr, isoTitle } from "@/lib/format/date";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import {
  useDeleteDraft,
  useDrafts,
  useUpdateDraft,
} from "@/lib/hooks/use-drafts";
import type { MailAccountMeta, MailDraft } from "@/lib/types";

/**
 * The draft reading pane — which for a draft is an editor, because there is
 * nothing to read that is not also editable.
 *
 * Saving is explicit, and it has to be: `POST /api/drafts/:accountId/:draftId`
 * REPLACES the draft by appending a new one and deleting the old, so every save
 * mints a new id. An autosave on keystroke would churn the Drafts folder and
 * invalidate the id the user's agent is holding. The new id is adopted from the
 * response, so the next save targets the draft that now exists.
 */
export function DraftEditor() {
  const app = useApp();
  const selection = app.selectedDraft;
  const drafts = useDrafts(app.account);
  const accounts = useAccounts();

  const draft = React.useMemo(
    () =>
      selection
        ? (drafts.drafts.find((entry) => entry.id === selection.draftId) ?? null)
        : null,
    [drafts.drafts, selection],
  );

  const account = React.useMemo(
    () =>
      selection
        ? ((accounts.data ?? []).find(
            (entry) => entry.id === selection.accountId,
          ) ?? null)
        : null,
    [accounts.data, selection],
  );

  if (!selection) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="text-center">
          <BrandGlyph size={20} className="mx-auto text-fg-disabled" />
          <p className="mt-3 text-[13px] leading-[18px] text-fg-tertiary">
            Pick a draft to keep writing it.
          </p>
        </div>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-[260px] text-center">
          <p className="text-[13px] leading-[18px] text-fg-tertiary">
            {drafts.isPending
              ? "Loading…"
              : "That draft is gone. It may have been sent or discarded elsewhere."}
          </p>
          {!drafts.isPending && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={app.clearSelection}
            >
              Back to drafts
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Keyed on the id so a save — which mints a NEW id — remounts the form on the
  // stored draft rather than leaving edited state pointing at a dead id.
  return <DraftForm key={draft.id} draft={draft} account={account} />;
}

function DraftForm({
  draft,
  account,
}: {
  draft: MailDraft;
  account: MailAccountMeta | null;
}) {
  const app = useApp();
  const save = useUpdateDraft();
  const remove = useDeleteDraft();

  const [to, setTo] = React.useState(draft.to);
  const [cc, setCc] = React.useState(draft.cc ?? "");
  const [bcc, setBcc] = React.useState(draft.bcc ?? "");
  const [subject, setSubject] = React.useState(draft.subject);
  const [text, setText] = React.useState(draft.bodyText);
  const [showCc, setShowCc] = React.useState(
    (draft.cc ?? "").length > 0 || (draft.bcc ?? "").length > 0,
  );
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const dirty =
    to !== draft.to ||
    cc !== (draft.cc ?? "") ||
    bcc !== (draft.bcc ?? "") ||
    subject !== draft.subject ||
    text !== draft.bodyText;

  const fields = () => ({
    to: to || undefined,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject: subject || undefined,
    text: text || undefined,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
  });

  const onSave = () => {
    save.mutate(
      { accountId: draft.accountId, draftId: draft.id, draft: fields() },
      {
        onSuccess: (ref) => {
          toast.success("Draft saved");
          // The old id stops resolving the moment the server deletes it, so the
          // selection has to follow the new one.
          app.selectDraft({ accountId: ref.accountId, draftId: ref.id });
        },
        onError: (error) =>
          toast.error("Could not save that draft", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  const onDelete = () => {
    remove.mutate(
      { accountId: draft.accountId, draftId: draft.id },
      {
        onSuccess: (result) => {
          setConfirmDelete(false);
          app.clearSelection();
          toast[result.deleted ? "success" : "warning"](
            result.deleted ? "Draft discarded" : "That draft was already gone",
          );
        },
        onError: (error) =>
          toast.error("Could not discard that draft", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  /**
   * Hand the draft to the composer, carrying its id. The composer deletes the
   * stored draft only after the server accepts the send, so a failed send never
   * costs the user their text.
   */
  const onMoveToCompose = () => {
    app.openCompose({
      account: account?.alias,
      to,
      cc,
      bcc,
      subject,
      text,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      draftId: draft.id,
      draftAccountId: draft.accountId,
    });
  };

  const busy = save.isPending || remove.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-1 border-b border-border-subtle bg-surface-2 px-3">
        {app.narrow && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={app.clearSelection}
          >
            <ChevronLeft className="size-4" strokeWidth={1.5} />
            Drafts
          </Button>
        )}

        <span className="mr-auto flex min-w-0 items-center gap-2">
          <span className="text-[11px] leading-4 font-medium tracking-[var(--tracking-label)] text-fg-tertiary uppercase">
            Draft
          </span>
          <time
            dateTime={isoAttr(draft.date)}
            title={isoTitle(draft.date)}
            className="tnum truncate text-[12px] leading-4 text-fg-tertiary"
          >
            {formatReaderDate(draft.date)}
          </time>
          {dirty && (
            <span className="text-[12px] leading-4 text-warning">Unsaved</span>
          )}
        </span>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Discard this draft"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-4" strokeWidth={1.5} />
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy || !dirty}
          aria-busy={save.isPending || undefined}
          onClick={onSave}
        >
          {save.isPending && <Spinner />}
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={onMoveToCompose}>
          <Send className="size-4" strokeWidth={1.5} />
          Open in composer
        </Button>
      </div>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-10">
        <div className="mx-auto max-w-[calc(var(--reader-measure)+2rem)] space-y-3 pt-5">
          <p className="text-[12px] leading-4 text-fg-tertiary">
            Stored in{" "}
            <span className="font-mono">{draft.folder}</span> on{" "}
            <span className="font-mono">
              {account?.alias ?? draft.accountId}
            </span>
            . Nothing here has been sent.
          </p>

          <Field id="draft-to" label="To">
            <Input
              id="draft-to"
              value={to}
              className="font-mono"
              placeholder="jane@example.com"
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>

          <button
            type="button"
            aria-expanded={showCc}
            onClick={() => setShowCc((value) => !value)}
            className="text-[12px] text-fg-tertiary hover:text-fg-secondary"
          >
            Cc / Bcc
          </button>

          {showCc && (
            <div className="grid grid-cols-2 gap-3">
              <Field id="draft-cc" label="Cc">
                <Input
                  id="draft-cc"
                  value={cc}
                  className="font-mono"
                  onChange={(event) => setCc(event.target.value)}
                />
              </Field>
              <Field id="draft-bcc" label="Bcc">
                <Input
                  id="draft-bcc"
                  value={bcc}
                  className="font-mono"
                  onChange={(event) => setBcc(event.target.value)}
                />
              </Field>
            </div>
          )}

          <Field id="draft-subject" label="Subject">
            <Input
              id="draft-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </Field>

          <Field id="draft-body" label="Message">
            <Textarea
              id="draft-body"
              rows={16}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  if (dirty && !busy) onSave();
                }
              }}
              className="max-h-[32rem] min-h-[18rem] resize-y"
            />
          </Field>

          {/* A draft can hold an HTML part written by an agent. This pane
              never renders it, and saving from here sends only the plain text,
              which drops it. */}
          {draft.bodyHtml && (
            <p className="text-[12px] leading-4 text-warning">
              This draft also has an HTML part. It is not shown here, and
              saving replaces the draft with the plain text above.
            </p>
          )}

          {save.isError && (
            <div role="alert">
              <p className="text-[12px] leading-4 text-danger">
                {friendlyError(
                  save.error instanceof Error ? save.error.message : save.error,
                )}
              </p>
              <TechnicalDetails
                raw={save.error instanceof Error ? save.error.message : save.error}
              />
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed from the Drafts folder on your mail server. Nothing
              that was already sent is affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                onDelete();
              }}
            >
              {remove.isPending && <Spinner />}
              {remove.isPending ? "Discarding…" : "Discard draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

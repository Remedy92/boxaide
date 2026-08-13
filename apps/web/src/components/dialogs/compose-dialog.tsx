"use client";

import * as React from "react";
import { toast } from "sonner";
import { Field, Kbd, Spinner, TechnicalDetails } from "@/components/atoms";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/api/errors";
import {
  splitAddressList,
  validateDraft,
  type DraftField,
} from "@/lib/format/address";
import { useAccounts } from "@/lib/hooks/use-accounts";
import type { ComposeSeed } from "@/lib/hooks/use-app-state";
import { useApp } from "@/lib/hooks/use-app-state";
import {
  useCreateDraft,
  useDeleteDraft,
  useUpdateDraft,
} from "@/lib/hooks/use-drafts";
import { useDecideOutbox } from "@/lib/hooks/use-outreach-mutations";
import { missingRecipients, useSend } from "@/lib/hooks/use-send";

/**
 * The composer.
 *
 * No attachment control — there is no upload path in SendMessageInput — and no
 * rich-text toggle, because this client refuses to render HTML and a composer
 * whose output it will not display is incoherent.
 *
 * Saving a draft IS supported: it stores plain text into the mailbox's own
 * Drafts folder through `POST /api/drafts`, so the same draft shows up in the
 * user's phone mail app and to any agent holding the MCP tools.
 */
export function ComposeDialog({
  open,
  seed,
  onOpenChange,
}: {
  open: boolean;
  seed: ComposeSeed | null;
  onOpenChange: (open: boolean) => void;
}) {
  // The form is keyed on the seed's nonce, so every open mounts a fresh one
  // with its fields already correct. That is what removes the state-syncing
  // effect this dialog used to need.
  if (!open || !seed) return null;
  return <ComposeForm key={seed.nonce} seed={seed} onOpenChange={onOpenChange} />;
}

function ComposeForm({
  seed,
  onOpenChange,
}: {
  seed: ComposeSeed;
  onOpenChange: (open: boolean) => void;
}) {
  const app = useApp();
  const accounts = useAccounts();
  const send = useSend();
  const createDraft = useCreateDraft();
  const updateDraft = useUpdateDraft();
  const deleteDraft = useDeleteDraft();
  const decideOutbox = useDecideOutbox();
  const list = accounts.data ?? [];

  const [account, setAccount] = React.useState(
    () => seed.account ?? accounts.data?.[0]?.alias ?? "",
  );
  const [to, setTo] = React.useState(seed.to);
  const [cc, setCc] = React.useState(seed.cc);
  const [bcc, setBcc] = React.useState(seed.bcc);
  const [subject, setSubject] = React.useState(seed.subject);
  const [text, setText] = React.useState(seed.text);
  const [showCc, setShowCc] = React.useState(
    seed.cc.length > 0 || seed.bcc.length > 0,
  );
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [invalid, setInvalid] = React.useState<{
    field: DraftField;
    message: string;
  } | null>(null);
  /* The draft this composer is bound to. It starts as the one it was opened
     from and is replaced on every save, because the update route mints a new
     id and retires the old one. */
  const [draftRef, setDraftRef] = React.useState<{
    accountId: string;
    draftId: string;
  } | null>(
    seed.draftId && seed.draftAccountId
      ? { accountId: seed.draftAccountId, draftId: seed.draftId }
      : null,
  );
  const toRef = React.useRef<HTMLInputElement | null>(null);
  const subjectRef = React.useRef<HTMLInputElement | null>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement | null>(null);

  const chosen = list.find((entry) => entry.alias === account) ?? null;
  const savingDraft = createDraft.isPending || updateDraft.isPending;
  const busy = send.isPending || savingDraft;

  const close = (force = false) => {
    if (!force && text.trim().length > 0) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const draftFields = () => ({
    to: to || undefined,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject: subject || undefined,
    text: text || undefined,
    inReplyTo: seed.inReplyTo,
    references: seed.references,
  });

  /**
   * Save without sending. A draft may be half-written — every field on
   * DraftInput is optional — so this deliberately runs none of the send-time
   * validation. The only requirement is a mailbox to store it in.
   */
  const saveDraft = (thenClose: boolean) => {
    if (!account) return;
    const onError = (error: unknown) =>
      toast.error("Could not save that draft", {
        description: friendlyError(
          error instanceof Error ? error.message : error,
        ),
      });

    if (draftRef) {
      updateDraft.mutate(
        {
          accountId: draftRef.accountId,
          draftId: draftRef.draftId,
          draft: draftFields(),
        },
        {
          onSuccess: (ref) => {
            setDraftRef({ accountId: ref.accountId, draftId: ref.id });
            toast.success("Draft saved");
            if (thenClose) onOpenChange(false);
          },
          onError,
        },
      );
      return;
    }

    createDraft.mutate(
      { account, draft: draftFields() },
      {
        onSuccess: (ref) => {
          setDraftRef({ accountId: ref.accountId, draftId: ref.id });
          toast.success("Saved to Drafts");
          if (thenClose) onOpenChange(false);
        },
        onError,
      },
    );
  };

  const submit = () => {
    if (!account) return;
    // Same gate the bundled UI got from `required` + reportValidity(): without
    // it an empty To reaches POST /api/messages/send and returns a 400.
    const problem = validateDraft({ to, subject, text });
    setInvalid(problem);
    if (problem) {
      const target =
        problem.field === "to"
          ? toRef.current
          : problem.field === "subject"
            ? subjectRef.current
            : bodyRef.current;
      target?.focus();
      return;
    }
    const typed = splitAddressList(to);
    send.mutate(
      {
        account,
        to,
        subject,
        text,
        cc: cc || undefined,
        bcc: bcc || undefined,
        inReplyTo: seed.inReplyTo,
        references: seed.references,
      },
      {
        onSuccess: (result) => {
          const missing = missingRecipients(typed, result.accepted);
          if (result.accepted.length === 0 || missing.length > 0) {
            toast.warning(
              `Sent, but the server did not accept: ${missing.join(", ") || "no recipients"}`,
            );
          } else {
            toast.success(`Sent to ${result.accepted.join(", ")}`);
          }
          /* Only now: a stored draft is discarded after the server has taken
             the message, never before, so a failed send cannot lose the text.
             The failure is reported and the draft is left alone. */
          if (draftRef) {
            const gone = draftRef;
            deleteDraft.mutate(
              { accountId: gone.accountId, draftId: gone.draftId },
              {
                onError: () =>
                  toast.warning("Sent, but the draft is still in Drafts", {
                    description: "Discard it from the Drafts view.",
                  }),
              },
            );
            if (app.selectedDraft?.draftId === gone.draftId) app.clearSelection();
          }
          /* Same rule for a queued outreach row this composer was opened to
             edit: the human has now sent their version, so the queued copy is
             rejected — after the send, never before — or the engine would post
             the agent's original as well. */
          if (seed.outboxId) {
            const queued = seed.outboxId;
            decideOutbox.mutate(
              { outboxId: queued, decision: "reject" },
              {
                onError: () =>
                  toast.warning("Sent, but the queued copy is still waiting", {
                    description:
                      "Reject it in the Outreach queue so it cannot go out twice.",
                  }),
              },
            );
            if (app.selectedOutbox === queued) app.selectOutbox(null);
          }
          onOpenChange(false);
        },
      },
    );
  };

  const title =
    seed.mode === "forward"
      ? "Forward message"
      : seed.mode === "reply" || seed.mode === "replyAll"
        ? "Reply"
        : draftRef
          ? "Continue draft"
          : "New message";

  return (
    <>
      <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
        <DialogContent
          className="max-w-[600px]"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              saveDraft(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="title-15">{title}</DialogTitle>
            <DialogDescription>
              Plain text only. Sley sends through your own SMTP server and
              forces the From address to the mailbox you pick.
            </DialogDescription>
          </DialogHeader>

          {seed.threadingUnavailable && (
            <p className="text-[12px] leading-4 text-fg-tertiary">
              This message has no Message-ID, so the reply will start a new
              thread.
            </p>
          )}

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label
                htmlFor="compose-from"
                className="text-[12px] font-medium text-fg-secondary"
              >
                From
              </Label>
              <Select value={account} onValueChange={setAccount}>
                <SelectTrigger id="compose-from" className="h-8 w-full">
                  <SelectValue placeholder="Pick a mailbox" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((entry) => (
                    <SelectItem key={entry.id} value={entry.alias}>
                      <span className="flex items-center gap-2">
                        {entry.alias}
                        <span className="font-mono text-[11px] text-fg-tertiary">
                          {entry.email}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Field id="compose-to" label="To">
              <Input
                id="compose-to"
                ref={toRef}
                value={to}
                className="font-mono"
                placeholder="jane@example.com, sam@example.com"
                aria-invalid={invalid?.field === "to" ? "true" : undefined}
                aria-describedby={
                  invalid?.field === "to" ? "compose-error" : undefined
                }
                onChange={(event) => {
                  setInvalid(null);
                  setTo(event.target.value);
                }}
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
                <Field id="compose-cc" label="Cc">
                  <Input
                    id="compose-cc"
                    value={cc}
                    className="font-mono"
                    onChange={(event) => setCc(event.target.value)}
                  />
                </Field>
                <Field id="compose-bcc" label="Bcc">
                  <Input
                    id="compose-bcc"
                    value={bcc}
                    className="font-mono"
                    onChange={(event) => setBcc(event.target.value)}
                  />
                </Field>
              </div>
            )}

            <Field id="compose-subject" label="Subject">
              <Input
                id="compose-subject"
                ref={subjectRef}
                value={subject}
                aria-invalid={invalid?.field === "subject" ? "true" : undefined}
                aria-describedby={
                  invalid?.field === "subject" ? "compose-error" : undefined
                }
                onChange={(event) => {
                  setInvalid(null);
                  setSubject(event.target.value);
                }}
              />
            </Field>

            <Field id="compose-body" label="Message">
              <Textarea
                id="compose-body"
                ref={bodyRef}
                rows={12}
                value={text}
                readOnly={send.isPending}
                aria-invalid={invalid?.field === "text" ? "true" : undefined}
                aria-describedby={
                  invalid?.field === "text" ? "compose-error" : undefined
                }
                onChange={(event) => {
                  setInvalid(null);
                  setText(event.target.value);
                }}
                className="max-h-[24rem] min-h-[15rem] resize-y"
              />
            </Field>
          </div>

          {invalid && (
            <p
              id="compose-error"
              role="alert"
              className="text-[12px] leading-4 text-danger"
            >
              {invalid.message}
            </p>
          )}

          {send.isError && (
            <div role="alert">
              <p className="text-[12px] leading-4 text-danger">
                {friendlyError(
                  send.error instanceof Error ? send.error.message : send.error,
                )}
              </p>
              <TechnicalDetails
                raw={send.error instanceof Error ? send.error.message : send.error}
              />
            </div>
          )}

          <DialogFooter className="items-center sm:justify-between">
            <span className="truncate font-mono text-[11px] text-fg-tertiary">
              {chosen
                ? `Sending from ${chosen.email}`
                : "Pick a mailbox to send from"}
            </span>
            <span className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => close()}
              >
                Discard
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !account}
                aria-busy={savingDraft || undefined}
                onClick={() => saveDraft(true)}
              >
                {savingDraft && <Spinner />}
                {savingDraft ? "Saving…" : "Save as draft"}
              </Button>
              <Button
                type="button"
                disabled={busy || !account}
                aria-busy={send.isPending || undefined}
                onClick={submit}
              >
                {send.isPending && <Spinner />}
                {send.isPending ? "Sending…" : "Send"}
                {!send.isPending && <Kbd>⌘↵</Kbd>}
              </Button>
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this message?</AlertDialogTitle>
            <AlertDialogDescription>
              {draftRef
                ? "Your saved draft stays in the Drafts folder. Anything typed since the last save is lost."
                : "Your text is not saved anywhere. Use Save as draft to keep it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDiscard(false);
                onOpenChange(false);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

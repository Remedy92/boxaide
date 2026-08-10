"use client";

import * as React from "react";
import { toast } from "sonner";
import { Kbd, Spinner, TechnicalDetails } from "@/components/atoms";
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
import { useAccountHue } from "@/lib/hooks/use-account-hue";
import { useAccounts } from "@/lib/hooks/use-accounts";
import type { ComposeSeed } from "@/lib/hooks/use-app-state";
import { missingRecipients, useSend } from "@/lib/hooks/use-send";

/**
 * §6.6. No attachment control (there is no upload path in SendMessageInput), no
 * rich-text toggle (the client refuses to render HTML, so a composer whose
 * output it will not display is incoherent), and no Save draft (there is no
 * draft endpoint).
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
  const accounts = useAccounts();
  const hueFor = useAccountHue();
  const send = useSend();
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
  const toRef = React.useRef<HTMLInputElement | null>(null);
  const subjectRef = React.useRef<HTMLInputElement | null>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement | null>(null);

  const chosen = list.find((entry) => entry.alias === account) ?? null;

  const close = (force = false) => {
    if (!force && text.trim().length > 0) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
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
        : "New message";

  return (
    <>
      <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
        <DialogContent
          className="max-w-[620px]"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle style={{ fontSize: "var(--text-display)" }}>
              {title}
            </DialogTitle>
            <DialogDescription>
              Plain text only. mailmux sends through your own SMTP server and
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
            <div className="space-y-1">
              <Label
                htmlFor="compose-from"
                className="text-[12px] font-medium text-fg-secondary"
              >
                From
              </Label>
              <Select value={account} onValueChange={setAccount}>
                <SelectTrigger id="compose-from" className="h-8 w-full text-[13px]">
                  <SelectValue placeholder="Pick a mailbox" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((entry) => (
                    <SelectItem key={entry.id} value={entry.alias}>
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="inline-block size-1.5 rounded-[var(--radius-full)]"
                          style={{ background: hueFor(entry.id) }}
                        />
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

            <div className="space-y-1">
              <Label
                htmlFor="compose-to"
                className="text-[12px] font-medium text-fg-secondary"
              >
                To
              </Label>
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
            </div>

            <button
              type="button"
              aria-expanded={showCc}
              onClick={() => setShowCc((value) => !value)}
              className="text-[12px] text-fg-tertiary hover:text-fg-secondary"
            >
              Cc / Bcc
            </button>

            {showCc && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label
                    htmlFor="compose-cc"
                    className="text-[12px] font-medium text-fg-secondary"
                  >
                    Cc
                  </Label>
                  <Input
                    id="compose-cc"
                    value={cc}
                    className="font-mono"
                    onChange={(event) => setCc(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor="compose-bcc"
                    className="text-[12px] font-medium text-fg-secondary"
                  >
                    Bcc
                  </Label>
                  <Input
                    id="compose-bcc"
                    value={bcc}
                    className="font-mono"
                    onChange={(event) => setBcc(event.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label
                htmlFor="compose-subject"
                className="text-[12px] font-medium text-fg-secondary"
              >
                Subject
              </Label>
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
            </div>

            <div className="space-y-1">
              <Label
                htmlFor="compose-body"
                className="text-[12px] font-medium text-fg-secondary"
              >
                Message
              </Label>
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
                className="max-h-[24rem] min-h-[16rem] resize-y"
              />
            </div>
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
            <span className="font-mono text-[11px] text-fg-tertiary">
              {chosen ? `Sending from ${chosen.email}` : "Pick a mailbox to send from"}
            </span>
            <span className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={send.isPending}
                onClick={() => close()}
              >
                Discard
              </Button>
              <Button
                type="button"
                disabled={send.isPending || !account}
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
              Your text is not saved anywhere.
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

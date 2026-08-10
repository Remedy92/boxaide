"use client";

import * as React from "react";
import { toast } from "sonner";
import { Kbd, Spinner, TechnicalDetails } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/api/errors";
import {
  displayName,
  splitAddressList,
  validateDraft,
  type DraftField,
} from "@/lib/format/address";
import { useAccountHue } from "@/lib/hooks/use-account-hue";
import { buildReplySeed } from "@/lib/format/reply";
import type { ComposeMode } from "@/lib/hooks/use-app-state";
import { missingRecipients, useSend } from "@/lib/hooks/use-send";
import type { MailAccountMeta, MailMessage } from "@/lib/types";

export type Draft = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
};

export type ReplyMode = Exclude<ComposeMode, "new">;

/**
 * §6.4.8. Docked at the bottom of the reader's scrollable content — not a fixed
 * overlay. On iOS a fixed composer over the virtual keyboard covers the text
 * being replied to, which is the one thing a reply composer must not do.
 *
 * The parent keys this component on the message id and the reply request's
 * nonce, so pressing r / a / f remounts it already expanded with the right
 * prefill. That is why there is not a single effect in here.
 *
 * There is no From picker: the server forces `from` to the account's own stored
 * address. No attachment control and no rich-text toggle either — no upload
 * path exists, and this client refuses to render HTML.
 */
export function InlineReply({
  message,
  account,
  initialMode,
  drafts,
}: {
  message: MailMessage;
  account: MailAccountMeta | null;
  /** Non-null ⇒ mount expanded, in this mode. */
  initialMode: ReplyMode | null;
  /** Draft text survives switching messages. In memory only — drafts are content. */
  drafts: React.RefObject<Map<string, Draft>>;
}) {
  const send = useSend();
  const hueFor = useAccountHue();

  const seedFor = (mode: ReplyMode) =>
    buildReplySeed(
      message,
      mode,
      account ? { alias: account.alias, email: account.email } : null,
    );

  const [mode, setMode] = React.useState<ReplyMode | null>(initialMode);
  const initial = React.useMemo(
    () => seedFor(initialMode ?? "reply"),
    // Recomputed only when the mounted identity changes, which the key forces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message.id, initialMode, account?.id],
  );

  const saved = drafts.current.get(message.id);
  const [draft, setDraft] = React.useState<Draft>(() => ({
    to: initial.to,
    cc: initial.cc,
    bcc: initial.bcc,
    subject: initial.subject,
    text: saved?.text ?? initial.text,
  }));
  const [showCc, setShowCc] = React.useState(initial.cc.length > 0);
  const [invalid, setInvalid] = React.useState<{
    field: DraftField;
    message: string;
  } | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const toRef = React.useRef<HTMLInputElement | null>(null);
  const subjectRef = React.useRef<HTMLInputElement | null>(null);

  const expand = (next: ReplyMode) => {
    const seed = seedFor(next);
    setMode(next);
    setDraft({
      to: seed.to,
      cc: seed.cc,
      bcc: seed.bcc,
      subject: seed.subject,
      text: drafts.current.get(message.id)?.text ?? seed.text,
    });
    setShowCc(seed.cc.length > 0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /* The retained draft is written from inside the updater, not from the
     render-scoped `draft`. Reading the outer value would persist a stale
     to/cc/subject whenever another field changed in the same batch. */
  const setText = (text: string) => {
    setDraft((value) => {
      const next = { ...value, text };
      drafts.current.set(message.id, next);
      return next;
    });
  };

  const submit = () => {
    if (!account) return;
    // The bundled UI had `required` + reportValidity() on a real form; this is
    // the same gate. Without it an empty To reaches the send endpoint and comes
    // back as a nodemailer 400.
    const problem = validateDraft(draft);
    setInvalid(problem);
    if (problem) {
      const target =
        problem.field === "to"
          ? toRef.current
          : problem.field === "subject"
            ? subjectRef.current
            : textareaRef.current;
      target?.focus();
      return;
    }
    const typed = splitAddressList(draft.to);
    send.mutate(
      {
        account: account.alias,
        to: draft.to,
        subject: draft.subject,
        text: draft.text,
        cc: draft.cc || undefined,
        bcc: draft.bcc || undefined,
        inReplyTo: initial.inReplyTo,
        references: initial.references,
      },
      {
        onSuccess: (result) => {
          const missing = missingRecipients(typed, result.accepted);
          if (result.accepted.length === 0 || missing.length > 0) {
            toast.warning(
              `Sent, but the server did not accept: ${
                missing.join(", ") || "no recipients"
              }`,
            );
          } else {
            toast.success(`Sent to ${result.accepted.join(", ")}`);
          }
          drafts.current.delete(message.id);
          setMode(null);
        },
      },
    );
  };

  if (mode === null) {
    return (
      <div className="mt-7 border-t border-border-subtle pt-4">
        <button
          type="button"
          onClick={() => expand("reply")}
          className="flex h-10 w-full items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-surface-1 px-3 text-left text-[13px] text-fg-tertiary hover:border-border-strong"
        >
          <span className="min-w-0 flex-1 truncate">
            Reply to {displayName(message.from)}…
          </span>
          <Kbd>⌘↵</Kbd>
        </button>
      </div>
    );
  }

  return (
    <div className="mailmux-expand mt-7 border-t border-border-subtle pt-4">
      {initial.threadingUnavailable && (
        <p className="mb-2 text-[12px] leading-4 text-fg-tertiary">
          This message has no Message-ID, so the reply will start a new thread.
        </p>
      )}

      <div className="space-y-2">
        <Field id="reply-to" label="To">
          <Input
            id="reply-to"
            ref={toRef}
            value={draft.to}
            className="font-mono"
            aria-invalid={invalid?.field === "to" ? "true" : undefined}
            aria-describedby={invalid?.field === "to" ? "reply-error" : undefined}
            onChange={(event) => {
              setInvalid(null);
              setDraft((value) => ({ ...value, to: event.target.value }));
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
          <>
            <Field id="reply-cc" label="Cc">
              <Input
                id="reply-cc"
                value={draft.cc}
                className="font-mono"
                onChange={(event) =>
                  setDraft((value) => ({ ...value, cc: event.target.value }))
                }
              />
            </Field>
            <Field id="reply-bcc" label="Bcc">
              <Input
                id="reply-bcc"
                value={draft.bcc}
                className="font-mono"
                onChange={(event) =>
                  setDraft((value) => ({ ...value, bcc: event.target.value }))
                }
              />
            </Field>
          </>
        )}

        <Field id="reply-subject" label="Subject">
          <Input
            id="reply-subject"
            ref={subjectRef}
            value={draft.subject}
            aria-invalid={invalid?.field === "subject" ? "true" : undefined}
            aria-describedby={
              invalid?.field === "subject" ? "reply-error" : undefined
            }
            onChange={(event) => {
              setInvalid(null);
              setDraft((value) => ({ ...value, subject: event.target.value }));
            }}
          />
        </Field>

        <Textarea
          ref={textareaRef}
          aria-label="Message body"
          rows={5}
          value={draft.text}
          readOnly={send.isPending}
          aria-invalid={invalid?.field === "text" ? "true" : undefined}
          aria-describedby={invalid?.field === "text" ? "reply-error" : undefined}
          onChange={(event) => {
            setInvalid(null);
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          className="max-h-[26rem] min-h-[7.5rem] resize-y"
        />
      </div>

      {invalid && (
        <p
          id="reply-error"
          role="alert"
          className="mt-2 text-[12px] leading-4 text-danger"
        >
          {invalid.message}
        </p>
      )}

      {send.isError && (
        <div role="alert" className="mt-2">
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

      <div className="mt-3 flex items-center gap-3">
        {account && (
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-fg-tertiary">
            <span
              aria-hidden="true"
              className="inline-block size-1.5 shrink-0 rounded-[var(--radius-full)]"
              style={{ background: hueFor(account.id) }}
            />
            <span className="truncate">Sending from {account.email}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setMode(null);
              drafts.current.delete(message.id);
            }}
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
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[12px] font-medium text-fg-secondary">
        {label}
      </Label>
      {children}
    </div>
  );
}

"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Spinner, StatusDot, TechnicalDetails } from "@/components/atoms";
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
import { friendlyError } from "@/lib/api/errors";
import {
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  PROVIDER_PRESETS,
} from "@/lib/constants";
import {
  useCreateAccount,
  useTestCredentials,
} from "@/lib/hooks/use-account-mutations";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { cn } from "@/lib/utils";

type Form = {
  alias: string;
  email: string;
  password: string;
  username: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
};

const DEFAULT_PRESET = "gmail";

/**
 * The form starts on the default preset's hosts, not blank. A checked "Gmail"
 * chip above two empty host fields claims a preset was applied when it was not.
 */
function formForPreset(id: string): Form {
  const preset =
    PROVIDER_PRESETS.find((entry) => entry.id === id) ?? PROVIDER_PRESETS[0];
  return {
    alias: "",
    email: "",
    password: "",
    username: "",
    imapHost: preset.imapHost,
    imapPort: String(preset.imapPort || DEFAULT_IMAP_PORT),
    smtpHost: preset.smtpHost,
    smtpPort: String(preset.smtpPort || DEFAULT_SMTP_PORT),
  };
}

/**
 * §6.5. There is no TLS switch: `smtpSecure` is derived as `port === 465`,
 * matching what web/app.js already sends, and `imapSecure` is always true. A
 * fifth toggle to get wrong helps nobody.
 */
export function ConnectMailboxDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const accounts = useAccounts();
  const create = useCreateAccount();
  const test = useTestCredentials();
  const [form, setForm] = React.useState<Form>(() => formForPreset(DEFAULT_PRESET));
  const [preset, setPreset] = React.useState(DEFAULT_PRESET);
  const [reveal, setReveal] = React.useState(false);
  const [validation, setValidation] = React.useState<string | null>(null);
  const emailRef = React.useRef<HTMLInputElement | null>(null);
  const passwordRef = React.useRef<HTMLInputElement | null>(null);
  const imapRef = React.useRef<HTMLInputElement | null>(null);
  const smtpRef = React.useRef<HTMLInputElement | null>(null);

  const chosen = PROVIDER_PRESETS.find((entry) => entry.id === preset);
  const existing = (accounts.data ?? []).find(
    (entry) => entry.alias === normalizeAlias(form.alias),
  );

  const applyPreset = (id: string) => {
    setPreset(id);
    const next = PROVIDER_PRESETS.find((entry) => entry.id === id);
    if (!next) return;
    setForm((value) => ({
      ...value,
      imapHost: next.imapHost,
      imapPort: String(next.imapPort),
      smtpHost: next.smtpHost,
      smtpPort: String(next.smtpPort),
    }));
  };

  const reset = () => {
    setForm(formForPreset(DEFAULT_PRESET));
    setPreset(DEFAULT_PRESET);
    setValidation(null);
    setReveal(false);
    test.reset();
    create.reset();
  };

  const credentials = () => ({
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort) || DEFAULT_IMAP_PORT,
    imapSecure: true,
    smtpHost: form.smtpHost.trim(),
    smtpPort: Number(form.smtpPort) || DEFAULT_SMTP_PORT,
    // Derived, exactly as web/app.js does it.
    smtpSecure: (Number(form.smtpPort) || DEFAULT_SMTP_PORT) === 465,
    username: form.username.trim() || form.email.trim(),
    password: form.password,
  });

  const requireBasics = (): boolean => {
    const missing: Array<[keyof Form, React.RefObject<HTMLInputElement | null>]> = [
      ["email", emailRef],
      ["password", passwordRef],
      ["imapHost", imapRef],
      ["smtpHost", smtpRef],
    ];
    for (const [field, ref] of missing) {
      if (!form[field].trim()) {
        ref.current?.focus();
        setValidation("Fill in email, password, IMAP host and SMTP host first.");
        return false;
      }
    }
    setValidation(null);
    return true;
  };

  const onTest = () => {
    if (!requireBasics()) return;
    test.mutate(credentials());
  };

  const onSave = () => {
    if (!requireBasics()) return;
    if (!form.alias.trim()) {
      setValidation("Give this mailbox a name.");
      return;
    }
    create.mutate(
      { alias: form.alias.trim(), email: form.email.trim(), ...credentials() },
      {
        onSuccess: () => {
          toast.success("Mailbox connected");
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  const busy = create.isPending || test.isPending;
  const presetRefs = React.useRef(new Map<string, HTMLButtonElement>());

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-[480px]"
        // The bundled UI submitted on Enter from any credential field
        // (web/app.js:560). This dialog renders no <form>, so the same
        // affordance has to be wired explicitly or Enter does nothing.
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
          if (!(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          if (!busy) onSave();
        }}
      >
        <DialogHeader>
          <DialogTitle style={{ fontSize: "var(--text-display)" }}>
            Connect a mailbox
          </DialogTitle>
          <DialogDescription>
            mailmux stores these credentials encrypted on your own machine and
            never sends them anywhere else.
          </DialogDescription>
        </DialogHeader>

        {/* One tab stop, arrows move the selection — role="radio" without a
            roving tabindex leaves five separate tab stops and dead arrow keys. */}
        <div
          role="radiogroup"
          aria-label="Provider preset"
          className="flex flex-wrap gap-1.5"
          onKeyDown={(event) => {
            const delta =
              event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
            if (delta === 0) return;
            event.preventDefault();
            const at = PROVIDER_PRESETS.findIndex((e) => e.id === preset);
            const next =
              PROVIDER_PRESETS[
                (Math.max(at, 0) + delta + PROVIDER_PRESETS.length) %
                  PROVIDER_PRESETS.length
              ];
            applyPreset(next.id);
            presetRefs.current.get(next.id)?.focus();
          }}
        >
          {PROVIDER_PRESETS.map((entry) => (
            <button
              key={entry.id}
              ref={(node) => {
                if (node) presetRefs.current.set(entry.id, node);
                else presetRefs.current.delete(entry.id);
              }}
              type="button"
              role="radio"
              aria-checked={preset === entry.id}
              tabIndex={preset === entry.id ? 0 : -1}
              onClick={() => applyPreset(entry.id)}
              className={cn(
                "h-8 rounded-[var(--radius-full)] border px-3 text-[13px]",
                preset === entry.id
                  ? "border-accent bg-accent-subtle text-accent"
                  : "border-border-control bg-surface-1 text-fg-secondary hover:border-[var(--text-secondary)]",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {chosen?.hint && (
          <p className="rounded-[var(--radius-md)] bg-surface-1 p-3 text-[12px] leading-4 text-fg-secondary">
            {chosen.hint}
          </p>
        )}

        <div className="space-y-3">
          <Field
            id="connect-alias"
            label="Name"
            helper="Shown in the sidebar. Lowercase, no spaces."
          >
            <Input
              id="connect-alias"
              value={form.alias}
              autoComplete="off"
              onChange={(event) =>
                setForm((value) => ({ ...value, alias: event.target.value }))
              }
            />
          </Field>

          <Field id="connect-email" label="Email address">
            <Input
              id="connect-email"
              ref={emailRef}
              type="email"
              value={form.email}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) =>
                setForm((value) => ({ ...value, email: event.target.value }))
              }
            />
          </Field>

          <Field id="connect-password" label="Password">
            <div className="relative">
              <Input
                id="connect-password"
                ref={passwordRef}
                type={reveal ? "text" : "password"}
                value={form.password}
                autoComplete="off"
                className="pr-8"
                onChange={(event) =>
                  setForm((value) => ({ ...value, password: event.target.value }))
                }
              />
              <button
                type="button"
                aria-label={reveal ? "Hide password" : "Show password"}
                onClick={() => setReveal((value) => !value)}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-tertiary hover:bg-surface-hover hover:text-fg"
              >
                {reveal ? (
                  <EyeOff className="size-3.5" strokeWidth={1.5} />
                ) : (
                  <Eye className="size-3.5" strokeWidth={1.5} />
                )}
              </button>
            </div>
          </Field>

          <Field id="connect-username" label="Username">
            <Input
              id="connect-username"
              value={form.username}
              placeholder="Same as email address"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) =>
                setForm((value) => ({ ...value, username: event.target.value }))
              }
            />
          </Field>

          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <Field id="connect-imap-host" label="IMAP host">
              <Input
                id="connect-imap-host"
                ref={imapRef}
                value={form.imapHost}
                spellCheck={false}
                className="font-mono"
                onChange={(event) =>
                  setForm((value) => ({ ...value, imapHost: event.target.value }))
                }
              />
            </Field>
            <Field id="connect-imap-port" label="Port">
              <Input
                id="connect-imap-port"
                inputMode="numeric"
                value={form.imapPort}
                className="font-mono"
                onChange={(event) =>
                  setForm((value) => ({ ...value, imapPort: event.target.value }))
                }
              />
            </Field>
          </div>

          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <Field id="connect-smtp-host" label="SMTP host">
              <Input
                id="connect-smtp-host"
                ref={smtpRef}
                value={form.smtpHost}
                spellCheck={false}
                className="font-mono"
                onChange={(event) =>
                  setForm((value) => ({ ...value, smtpHost: event.target.value }))
                }
              />
            </Field>
            <Field id="connect-smtp-port" label="Port">
              <Input
                id="connect-smtp-port"
                inputMode="numeric"
                value={form.smtpPort}
                className="font-mono"
                onChange={(event) =>
                  setForm((value) => ({ ...value, smtpPort: event.target.value }))
                }
              />
            </Field>
          </div>
        </div>

        {existing && (
          <p className="text-[12px] leading-4 text-fg-tertiary">
            A mailbox named “{existing.alias}” already exists. Saving replaces its
            credentials.
          </p>
        )}

        {validation && (
          <p className="text-[12px] leading-4 text-danger">{validation}</p>
        )}

        {test.isSuccess && test.data.ok && (
          <p className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-success-bg px-2 py-1.5 text-[12px] text-success">
            <StatusDot tone="success" />
            Connection works. You can save the mailbox now.
          </p>
        )}

        {test.isSuccess && !test.data.ok && (
          <div>
            <p className="text-[12px] leading-4 text-danger">
              {friendlyError(test.data.error)}
            </p>
            <TechnicalDetails raw={test.data.error} />
          </div>
        )}

        {test.isError && (
          <div>
            <p className="text-[12px] leading-4 text-danger">
              {friendlyError(
                test.error instanceof Error ? test.error.message : test.error,
              )}
            </p>
            <TechnicalDetails
              raw={test.error instanceof Error ? test.error.message : test.error}
            />
          </div>
        )}

        {create.isError && (
          <div>
            <p className="text-[12px] leading-4 text-danger">
              {friendlyError(
                create.error instanceof Error ? create.error.message : create.error,
              )}
            </p>
            <TechnicalDetails
              raw={
                create.error instanceof Error ? create.error.message : create.error
              }
            />
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            aria-busy={test.isPending || undefined}
            onClick={onTest}
          >
            {test.isPending && <Spinner />}
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
          <Button
            type="button"
            disabled={busy}
            aria-busy={create.isPending || undefined}
            onClick={onSave}
          >
            {create.isPending && <Spinner />}
            {create.isPending
              ? "Testing connection…"
              : existing
                ? "Update mailbox"
                : "Connect mailbox"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The server normalises the alias exactly this way (service.ts:49). */
function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function Field({
  id,
  label,
  helper,
  children,
}: {
  id: string;
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[12px] font-medium text-fg-secondary">
        {label}
      </Label>
      {children}
      {helper && <p className="text-[12px] leading-4 text-fg-tertiary">{helper}</p>}
    </div>
  );
}

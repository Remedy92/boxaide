"use client";

import * as React from "react";
import { ChevronRight, ExternalLink, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Field, Spinner, TechnicalDetails } from "@/components/atoms";
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
import { friendlyError } from "@/lib/api/errors";
import {
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  GMAIL_PASSWORD_PROBLEM,
  PROVIDER_PRESETS,
  aliasForEmail,
  guessHostsForEmail,
  isGoogleAppPassword,
  presetForEmail,
  stripPasswordSpaces,
} from "@/lib/constants";
import { useCreateAccount } from "@/lib/hooks/use-account-mutations";
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
 * Two fields and a button. Everything else — the name, the username, four host
 * and port boxes — is filled in from the address and hidden behind "More
 * settings", because the only two answers a person actually holds are their
 * address and their password.
 *
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
  const [form, setForm] = React.useState<Form>(() => formForPreset(DEFAULT_PRESET));
  const [preset, setPreset] = React.useState(DEFAULT_PRESET);
  const [reveal, setReveal] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [validation, setValidation] = React.useState<string | null>(null);
  const emailRef = React.useRef<HTMLInputElement | null>(null);
  const passwordRef = React.useRef<HTMLInputElement | null>(null);
  const imapRef = React.useRef<HTMLInputElement | null>(null);
  const smtpRef = React.useRef<HTMLInputElement | null>(null);
  /* A chip picked by hand keeps its hosts: a custom domain on Google Workspace,
     or Other in front of a company gateway, must survive the rest of the
     address being typed. Only the chip row sets this. */
  const pinned = React.useRef(false);

  const chosen = PROVIDER_PRESETS.find((entry) => entry.id === preset);
  /* The name that will be stored: what was typed under More settings, or the
     part of the address in front of the @. */
  const alias = form.alias.trim()
    ? normalizeAlias(form.alias)
    : form.email.trim()
      ? aliasForEmail(form.email)
      : "";
  const existing = (accounts.data ?? []).find((entry) => entry.alias === alias);

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

  /** The chip row: the same apply, plus the pin the address cannot undo. */
  const choosePreset = (id: string) => {
    pinned.current = true;
    applyPreset(id);
    // "Other" carries no hosts of its own. Hiding two empty boxes behind a
    // toggle would let someone press Connect with nothing to connect to.
    if (id === "other") setAdvanced(true);
  };

  const onEmailChange = (value: string) => {
    setForm((current) => ({ ...current, email: value }));
    setValidation(null);
    if (pinned.current) return;
    const guess = presetForEmail(value);
    if (guess) {
      if (guess.id !== preset) applyPreset(guess.id);
      return;
    }
    // A domain no preset claims: guess imap./smtp. in front of it rather than
    // leaving imap.gmail.com sitting under someone's company address.
    const hosts = guessHostsForEmail(value);
    if (!hosts) return;
    setPreset("other");
    setForm((current) => ({
      ...current,
      imapHost: hosts.imapHost,
      imapPort: String(DEFAULT_IMAP_PORT),
      smtpHost: hosts.smtpHost,
      smtpPort: String(DEFAULT_SMTP_PORT),
    }));
  };

  const reset = () => {
    setForm(formForPreset(DEFAULT_PRESET));
    setPreset(DEFAULT_PRESET);
    pinned.current = false;
    setValidation(null);
    setReveal(false);
    setAdvanced(false);
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
    password: stripPasswordSpaces(form.password),
  });

  const requireBasics = (): boolean => {
    if (!form.email.trim()) {
      emailRef.current?.focus();
      setValidation("Type the address of the mailbox you want to read.");
      return false;
    }
    if (!stripPasswordSpaces(form.password)) {
      passwordRef.current?.focus();
      setValidation(
        `Paste the ${(chosen?.passwordName ?? "password").toLowerCase()} for this mailbox.`,
      );
      return false;
    }
    if (preset === "gmail" && !isGoogleAppPassword(form.password)) {
      passwordRef.current?.focus();
      setValidation(GMAIL_PASSWORD_PROBLEM);
      return false;
    }
    // Only reachable on "Other" with the guess cleared: every preset carries
    // its own hosts, so this opens the section that holds the empty box.
    for (const [field, ref] of [
      ["imapHost", imapRef],
      ["smtpHost", smtpRef],
    ] as const) {
      if (!form[field].trim()) {
        setAdvanced(true);
        setValidation("Two more details are needed from your email provider. They are under More settings.");
        window.setTimeout(() => ref.current?.focus(), 0);
        return false;
      }
    }
    setValidation(null);
    return true;
  };

  const onSave = () => {
    if (!requireBasics()) return;
    create.mutate(
      { alias, email: form.email.trim(), ...credentials() },
      {
        onSuccess: () => {
          toast.success("Mailbox connected");
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  const busy = create.isPending;
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
          <DialogTitle className="title-15">
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
            choosePreset(next.id);
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
              onClick={() => choosePreset(entry.id)}
              className={cn(
                "h-8 rounded-[var(--radius-md)] border px-3 text-[13px]",
                "transition-colors duration-[var(--dur-fast)]",
                preset === entry.id
                  ? "border-accent bg-accent-subtle text-accent"
                  : "border-border-control bg-surface-2 text-fg-secondary hover:bg-surface-hover hover:text-fg",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <Field id="connect-email" label="Email address">
            <Input
              id="connect-email"
              ref={emailRef}
              type="email"
              value={form.email}
              autoComplete="off"
              spellCheck={false}
              placeholder="you@example.com"
              onChange={(event) => onEmailChange(event.target.value)}
            />
          </Field>

          <Field
            id="connect-password"
            label={chosen?.passwordName ?? "Password"}
            helper={chosen?.hint || undefined}
          >
            <div className="relative">
              <Input
                id="connect-password"
                ref={passwordRef}
                type={reveal ? "text" : "password"}
                value={form.password}
                autoComplete="off"
                placeholder={chosen?.passwordPlaceholder || undefined}
                className="pr-8"
                onChange={(event) => {
                  setValidation(null);
                  setForm((value) => ({ ...value, password: event.target.value }));
                }}
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
            {chosen?.passwordUrl && (
              <Button asChild variant="secondary" size="sm">
                <a
                  href={chosen.passwordUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <ExternalLink className="size-3.5" strokeWidth={1.5} />
                  {chosen.passwordUrlLabel}
                </a>
              </Button>
            )}
          </Field>

          <button
            type="button"
            aria-expanded={advanced}
            aria-controls="connect-advanced"
            onClick={() => setAdvanced((value) => !value)}
            className="flex items-center gap-1 text-[12px] text-fg-tertiary hover:text-fg-secondary"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform duration-[var(--dur-fast)]",
                advanced && "rotate-90",
              )}
              strokeWidth={1.5}
            />
            More settings
          </button>

          {advanced && (
            <div id="connect-advanced" className="space-y-3">
              <Field
                id="connect-alias"
                label="Name"
                helper="Shown in the sidebar. Lowercase, no spaces."
              >
                <Input
                  id="connect-alias"
                  value={form.alias}
                  autoComplete="off"
                  placeholder={alias || "Taken from the address"}
                  onChange={(event) =>
                    setForm((value) => ({ ...value, alias: event.target.value }))
                  }
                />
              </Field>

              <Field
                id="connect-username"
                label="Username"
                helper="Only if your provider signs you in with something other than your address."
              >
                <Input
                  id="connect-username"
                  value={form.username}
                  placeholder={form.email.trim() || "Same as email address"}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) =>
                    setForm((value) => ({ ...value, username: event.target.value }))
                  }
                />
              </Field>

              <div className="grid grid-cols-[1fr_5rem] gap-2">
                <Field id="connect-imap-host" label="Incoming server (IMAP)">
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
                <Field id="connect-smtp-host" label="Outgoing server (SMTP)">
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
          )}
        </div>

        {existing && (
          <p className="text-[12px] leading-4 text-fg-tertiary">
            A mailbox named “{existing.alias}” already exists. Saving replaces its
            credentials.
          </p>
        )}

        <div role="status" aria-live="polite">
          {validation && (
            <p className="text-[12px] leading-4 text-danger">{validation}</p>
          )}

          {create.isError && (
            <div>
              <p className="text-[12px] leading-4 text-danger">
                {friendlyError(
                  create.error instanceof Error
                    ? create.error.message
                    : create.error,
                )}
              </p>
              <TechnicalDetails
                raw={
                  create.error instanceof Error
                    ? create.error.message
                    : create.error
                }
              />
            </div>
          )}
        </div>

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

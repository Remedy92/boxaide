"use client";

import * as React from "react";
import { ArrowLeft, ExternalLink, Eye, EyeOff, Plug } from "lucide-react";
import { toast } from "sonner";
import {
  BrandGlyph,
  Field,
  Spinner,
  StatusDot,
  TechnicalDetails,
} from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, friendlyError } from "@/lib/api/errors";
import { getApiHealth, getHealth, getLocalBootstrap } from "@/lib/api/endpoints";
import {
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  GMAIL_PASSWORD_PROBLEM,
  PROVIDER_PRESETS,
  isGoogleAppPassword,
  presetForEmail,
  stripPasswordSpaces,
  type ProviderPreset,
} from "@/lib/constants";
import { useCreateAccount } from "@/lib/hooks/use-account-mutations";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import { useSettings, useUpdateSettings } from "@/lib/hooks/use-settings";
import { hostLabel, isValidBaseUrl, normalizeBaseUrl } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * First run, for someone who has never configured a mail client.
 *
 * Three steps, in the order the product actually needs them: reach the server,
 * add one mailbox, done. It is a full-screen surface rather than a dialog
 * because there is nothing behind it worth showing — with no token there is no
 * mail to look at.
 *
 * It writes exactly two things: the server URL and token into localStorage
 * (through useUpdateSettings, which purges the query cache when either
 * changes), and one mailbox through POST /api/accounts.
 *
 * /api/local-bootstrap is called under exactly one condition: the page's own
 * origin IS the server address and that origin is loopback — the page is the
 * server's own UI, so step one completes with no copy-paste. Served from
 * anywhere else, a human pastes the token.
 */

type StepId = 1 | 2 | 3;

type Probe =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; fixture: boolean }
  | { status: "fail"; message: string; raw: string };

type Auth =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; version: string }
  | { status: "fail"; message: string; raw: string };

export function SetupWizard() {
  const app = useApp();
  const settings = useSettings();
  const accounts = useAccounts();
  const [step, setStep] = React.useState<StepId>(1);

  const connected = accounts.data ?? [];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-surface-1">
      <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col px-6 py-10">
        <header className="mailmux-rise flex items-center gap-2">
          <BrandGlyph className="text-fg" />
          <span className="text-[13px] font-semibold tracking-[var(--tracking-tight)] text-fg">
            mailmux
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            {([1, 2, 3] as const).map((index) => (
              <span
                key={index}
                aria-hidden="true"
                className={cn(
                  "h-[3px] w-6 rounded-[var(--radius-full)] transition-colors duration-[var(--dur-enter)]",
                  index <= step ? "bg-accent" : "bg-border-strong",
                )}
              />
            ))}
            <span className="sr-only">Step {step} of 3</span>
          </span>
        </header>

        <div className="mailmux-rise mt-10 flex-1">
          {step === 1 && (
            <ServerStep
              onDone={() => setStep(2)}
              onSkip={app.finishWizard}
            />
          )}
          {step === 2 && (
            <MailboxStep
              connected={connected.length}
              onBack={() => setStep(1)}
              onDone={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <DoneStep
              mailboxes={connected.length}
              host={settings.baseUrl ? hostLabel(settings.baseUrl) : ""}
              onFinish={app.finishWizard}
              onConnectAgent={() => {
                app.finishWizard();
                app.openDialog("agent");
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* step 1 — the server                                                        */
/* -------------------------------------------------------------------------- */

function ServerStep({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [baseUrl, setBaseUrl] = React.useState(() => settings.baseUrl);
  const [token, setToken] = React.useState(() => settings.token);
  const [reveal, setReveal] = React.useState(false);
  const [probe, setProbe] = React.useState<Probe>({ status: "idle" });
  const [auth, setAuth] = React.useState<Auth>({ status: "idle" });
  /* "detecting" is the first render: one quiet line while the page finds and
     signs into its own server. Most people never see the form below — it is
     the fallback for a remotely hosted page or a server that is not running,
     and those are the only audiences the address and token fields have. */
  const [phase, setPhase] = React.useState<"detecting" | "manual">("detecting");

  /* The address this page was served from. When mailmux serves its own build,
     that address IS the server — no typing, no CORS, no local-network prompt.
     A static deployment on some other host gets `null` and types it in. */
  const pageOrigin = React.useMemo(() => {
    if (typeof window === "undefined") return null;
    const { origin, protocol } = window.location;
    if (protocol !== "http:" && protocol !== "https:") return null;
    return normalizeBaseUrl(origin);
  }, []);
  const sameOrigin = pageOrigin !== null && isSameServer(pageOrigin, baseUrl);

  const runProbe = React.useCallback(async (url: string) => {
    if (!isValidBaseUrl(url)) {
      setProbe({
        status: "fail",
        message: "That is not a full address. It should look like http://127.0.0.1:8787.",
        raw: "",
      });
      return false;
    }
    setProbe({ status: "checking" });
    try {
      const health = await getHealth({ baseUrl: normalizeBaseUrl(url), token: "" });
      setProbe({ status: "ok", fixture: health.fixture });
      return true;
    } catch (error) {
      setProbe({
        status: "fail",
        message: describe(error, hostLabel(url)),
        raw: error instanceof ApiError ? error.raw : String(error ?? ""),
      });
      return false;
    }
  }, []);

  /* Auto-detect on arrival, in the order that is true rather than convenient:
     the stored address first, and only if nothing answers there, the address
     this page is served from. Served by mailmux itself, the first probe already
     succeeds and step one passes before the heading has been read. Deployed to
     a static host, the page origin is not a mail server and adopting it would
     be a confident wrong answer. */
  /* Same-origin loopback only: the page IS the server's own UI, so ask it for
     the token instead of sending a person into a hidden data folder. The fetch
     goes to the page's OWN origin — /api/local-bootstrap answers with no CORS
     headers by design, so it is only readable same-origin, and the server
     additionally requires a loopback Host. The page origin is then adopted as
     the base URL, which keeps every later request same-origin too. Failure is
     silent on purpose — the manual paste path below is the fallback, not an
     error state. */
  const adoptLocalToken = React.useCallback(
    async (url: string): Promise<boolean> => {
      setAuth({ status: "checking" });
      try {
        const boot = await getLocalBootstrap({ baseUrl: url, token: "" });
        const api = await getApiHealth({ baseUrl: url, token: boot.token });
        setBaseUrl(url);
        setToken(boot.token);
        setAuth({ status: "ok", version: api.version });
        update({ baseUrl: url, token: boot.token });
        return true;
      } catch {
        setAuth({ status: "idle" });
        return false;
      }
    },
    [update],
  );

  /* A token from an earlier visit: prove it still works, silently. */
  const verifyStored = React.useCallback(
    async (url: string, stored: string): Promise<boolean> => {
      try {
        const api = await getApiHealth({ baseUrl: url, token: stored });
        setAuth({ status: "ok", version: api.version });
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const probeRef = React.useRef(runProbe);
  const adoptRef = React.useRef(adoptLocalToken);
  const verifyStoredRef = React.useRef(verifyStored);
  const onDoneRef = React.useRef(onDone);
  React.useEffect(() => {
    probeRef.current = runProbe;
    adoptRef.current = adoptLocalToken;
    verifyStoredRef.current = verifyStored;
    onDoneRef.current = onDone;
  }, [runProbe, adoptLocalToken, verifyStored, onDone]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = settings.baseUrl;
      let live: string | null = null;
      if (stored && (await probeRef.current(stored))) {
        live = normalizeBaseUrl(stored);
      }
      if (!live && !cancelled && pageOrigin && pageOrigin !== normalizeBaseUrl(stored)) {
        if (await probeRef.current(pageOrigin)) {
          if (!cancelled) setBaseUrl(pageOrigin);
          live = pageOrigin;
        }
      }
      if (!cancelled && live) {
        // Signed in without a human: a still-valid stored token, or the
        // server's own page vouching for itself. Either way there is no
        // decision left on this screen, so it does not appear.
        if (settings.token) {
          if (await verifyStoredRef.current(live, settings.token)) {
            if (!cancelled) onDoneRef.current();
            return;
          }
        } else if (pageOrigin && isSameServer(pageOrigin, live)) {
          if (await adoptRef.current(pageOrigin)) {
            if (!cancelled) onDoneRef.current();
            return;
          }
        }
      }
      if (!cancelled) setPhase("manual");
    })();
    return () => {
      cancelled = true;
    };
    // Once, on mount: re-probing on every keystroke would hammer a server that
    // is not there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async () => {
    const reachable = await runProbe(baseUrl);
    if (!reachable) return;
    if (!token.trim()) {
      setAuth({
        status: "fail",
        message: "Paste the token first — it is the line mailmux serve prints.",
        raw: "",
      });
      return;
    }
    setAuth({ status: "checking" });
    const ctx = { baseUrl: normalizeBaseUrl(baseUrl), token: token.trim() };
    try {
      const api = await getApiHealth(ctx);
      setAuth({ status: "ok", version: api.version });
      update({ baseUrl: ctx.baseUrl, token: ctx.token });
    } catch (error) {
      setAuth({
        status: "fail",
        message:
          error instanceof ApiError && error.kind === "unauthorized"
            ? "Your server said no to that token. Copy the whole line, with no spaces."
            : describe(error, hostLabel(baseUrl)),
        raw: error instanceof ApiError ? error.raw : String(error ?? ""),
      });
    }
  };

  if (phase === "detecting") {
    return (
      <section
        aria-live="polite"
        className="flex min-h-[280px] items-center justify-center"
      >
        <p className="flex items-center gap-2 text-[13px] leading-[18px] text-fg-secondary">
          <Spinner className="text-fg-tertiary" />
          Getting things ready…
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="wizard-step-1">
      <h1
        id="wizard-step-1"
        className="text-[15px] leading-5 font-semibold tracking-[var(--tracking-tight)] text-fg"
      >
        Find your mailmux
      </h1>
      <p className="mt-1.5 text-[13px] leading-[18px] text-fg-secondary">
        mailmux runs on your own computer. This page talks to it directly —
        nothing about your mail passes through anyone else.
      </p>

      <div className="mt-6 space-y-4">
        <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-3">
          <div className="flex items-center gap-2">
            {probe.status === "checking" ? (
              <Spinner className="text-fg-tertiary" />
            ) : (
              <StatusDot
                tone={
                  probe.status === "ok"
                    ? "success"
                    : probe.status === "fail"
                      ? "danger"
                      : "muted"
                }
              />
            )}
            <span className="text-[13px] leading-[18px] text-fg">
              {probe.status === "checking"
                ? `Looking for ${hostLabel(baseUrl)}…`
                : probe.status === "ok"
                  ? sameOrigin
                    ? "Found it — this page is served by your mailmux."
                    : `Found mailmux at ${hostLabel(baseUrl)}.`
                  : probe.status === "fail"
                    ? "No mailmux answered."
                    : "Not checked yet."}
            </span>
          </div>

          {probe.status === "ok" && probe.fixture && (
            <p className="mt-1.5 text-[12px] leading-4 text-warning">
              It is running in demo mode, so the mail you will see is made up.
            </p>
          )}

          {probe.status === "fail" && (
            <>
              <p className="mt-1.5 text-[12px] leading-4 text-fg-secondary">
                {probe.message}
              </p>
              <p className="mt-1.5 text-[12px] leading-4 text-fg-tertiary">
                Open a terminal and run{" "}
                <code className="font-mono text-fg-secondary">mailmux serve</code>
                , then press Check again.
              </p>
              <TechnicalDetails raw={probe.raw} />
            </>
          )}
        </div>

        <Field
          id="wizard-base-url"
          label="Server address"
          helper={
            sameOrigin
              ? "This is the address you are reading this page on."
              : "The address mailmux printed when it started."
          }
        >
          <Input
            id="wizard-base-url"
            value={baseUrl}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="font-mono"
            placeholder="http://127.0.0.1:8787"
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setProbe({ status: "idle" });
              setAuth({ status: "idle" });
            }}
          />
        </Field>

        <Field
          id="wizard-token"
          label="Access token"
          helper="mailmux serve prints this on its third line. It is also in the file bearer.token inside your data folder."
        >
          <div className="relative">
            <Input
              id="wizard-token"
              type={reveal ? "text" : "password"}
              value={token}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              className="pr-8 font-mono"
              onChange={(event) => {
                setToken(event.target.value);
                setAuth({ status: "idle" });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void verify();
              }}
            />
            <button
              type="button"
              aria-label={reveal ? "Hide token" : "Show token"}
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

        <div role="status" aria-live="polite">
          {auth.status === "ok" && (
            <p className="flex items-center gap-1.5 text-[12px] text-success">
              <StatusDot tone="success" />
              Connected — mailmux {auth.version}
            </p>
          )}
          {auth.status === "fail" && (
            <div>
              <p className="flex items-center gap-1.5 text-[12px] text-danger">
                <StatusDot tone="danger" />
                {auth.message}
              </p>
              <TechnicalDetails raw={auth.raw} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={auth.status === "checking" || probe.status === "checking"}
          aria-busy={auth.status === "checking" || undefined}
          onClick={() => void verify()}
        >
          {(auth.status === "checking" || probe.status === "checking") && (
            <Spinner />
          )}
          Check
        </Button>
        <Button
          type="button"
          disabled={auth.status !== "ok"}
          onClick={onDone}
        >
          Continue
        </Button>
        <button
          type="button"
          onClick={onSkip}
          className="ml-auto text-[12px] text-fg-tertiary hover:text-fg-secondary"
        >
          Skip setup
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* step 2 — the first mailbox                                                 */
/* -------------------------------------------------------------------------- */

function MailboxStep({
  connected,
  onBack,
  onDone,
}: {
  connected: number;
  onBack: () => void;
  onDone: () => void;
}) {
  const create = useCreateAccount();
  const [preset, setPreset] = React.useState<ProviderPreset>(PROVIDER_PRESETS[0]);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [imapHost, setImapHost] = React.useState(PROVIDER_PRESETS[0].imapHost);
  const [imapPort, setImapPort] = React.useState(
    String(PROVIDER_PRESETS[0].imapPort),
  );
  const [smtpHost, setSmtpHost] = React.useState(PROVIDER_PRESETS[0].smtpHost);
  const [smtpPort, setSmtpPort] = React.useState(
    String(PROVIDER_PRESETS[0].smtpPort),
  );
  const [problem, setProblem] = React.useState<string | null>(null);
  const presetRefs = React.useRef(new Map<string, HTMLButtonElement>());
  /* Someone who picks a provider by hand keeps it: a custom domain on Google
     Workspace, or Other in front of a company gateway, must survive the rest of
     the address being typed. Only the row itself sets this. */
  const pinned = React.useRef(false);

  const applyPreset = (next: ProviderPreset) => {
    setPreset(next);
    setImapHost(next.imapHost);
    setImapPort(String(next.imapPort));
    setSmtpHost(next.smtpHost);
    setSmtpPort(String(next.smtpPort));
    setProblem(null);
    create.reset();
    if (next.id === "other") setAdvanced(true);
  };

  /** The provider row: the same apply, plus the pin the address cannot undo. */
  const choosePreset = (next: ProviderPreset) => {
    pinned.current = true;
    applyPreset(next);
  };

  const onEmailChange = (value: string) => {
    setEmail(value);
    setProblem(null);
    if (pinned.current) return;
    const guess = presetForEmail(value);
    if (guess && guess.id !== preset.id) applyPreset(guess);
  };

  const credentials = () => ({
    imapHost: imapHost.trim(),
    imapPort: Number(imapPort) || DEFAULT_IMAP_PORT,
    imapSecure: true,
    smtpHost: smtpHost.trim(),
    smtpPort: Number(smtpPort) || DEFAULT_SMTP_PORT,
    // Derived, exactly as the compact dialog does it: 465 is implicit TLS,
    // everything else is STARTTLS. A fifth toggle to get wrong helps nobody.
    smtpSecure: (Number(smtpPort) || DEFAULT_SMTP_PORT) === 465,
    username: username.trim() || email.trim(),
    password: stripPasswordSpaces(password),
  });

  const ready = () => {
    if (!email.trim()) {
      setProblem("Type the email address of the mailbox you want to read.");
      return false;
    }
    if (!stripPasswordSpaces(password)) {
      setProblem(`Paste the ${preset.passwordName.toLowerCase()} you just made.`);
      return false;
    }
    if (preset.id === "gmail" && !isGoogleAppPassword(password)) {
      setProblem(GMAIL_PASSWORD_PROBLEM);
      return false;
    }
    if (!imapHost.trim() || !smtpHost.trim()) {
      setProblem("Fill in both server names under More settings.");
      setAdvanced(true);
      return false;
    }
    setProblem(null);
    return true;
  };

  const connect = () => {
    if (!ready()) return;
    create.mutate(
      {
        // The alias is the part of the address before the @, which is what a
        // person would have called it anyway. The server normalises it again.
        alias: aliasFor(email),
        email: email.trim(),
        ...credentials(),
      },
      {
        onSuccess: () => {
          toast.success("Mailbox connected");
          onDone();
        },
      },
    );
  };

  const busy = create.isPending;

  return (
    <section aria-labelledby="wizard-step-2">
      <h1
        id="wizard-step-2"
        className="text-[15px] leading-5 font-semibold tracking-[var(--tracking-tight)] text-fg"
      >
        Add your first mailbox
      </h1>
      <p className="mt-1.5 text-[13px] leading-[18px] text-fg-secondary">
        Your password is encrypted and stays in mailmux&rsquo;s data folder on
        this computer.
      </p>

      <div
        role="radiogroup"
        aria-label="Email provider"
        className="mt-6 flex flex-wrap gap-1.5"
        onKeyDown={(event) => {
          const delta =
            event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 1
              : event.key === "ArrowLeft" || event.key === "ArrowUp"
                ? -1
                : 0;
          if (delta === 0) return;
          event.preventDefault();
          const at = PROVIDER_PRESETS.findIndex((e) => e.id === preset.id);
          const next =
            PROVIDER_PRESETS[
              (Math.max(at, 0) + delta + PROVIDER_PRESETS.length) %
                PROVIDER_PRESETS.length
            ];
          choosePreset(next);
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
            aria-checked={preset.id === entry.id}
            tabIndex={preset.id === entry.id ? 0 : -1}
            onClick={() => choosePreset(entry)}
            className={cn(
              "h-8 rounded-[var(--radius-md)] border px-3 text-[13px]",
              "transition-colors duration-[var(--dur-fast)]",
              preset.id === entry.id
                ? "border-accent bg-accent-subtle text-accent"
                : "border-border-control bg-surface-2 text-fg-secondary hover:bg-surface-hover hover:text-fg",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* The instructions, not a hint. Every provider on that row refuses a
          normal account password over IMAP, so this is the part that decides
          whether the next click works. */}
      <ol className="mt-4 space-y-2 rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-3.5">
        {preset.steps.map((line, index) => (
          <li key={line} className="flex gap-2.5">
            <span className="tnum mt-[1px] w-4 shrink-0 text-right text-[11px] leading-[18px] text-fg-tertiary">
              {index + 1}
            </span>
            <span className="text-[13px] leading-[18px] text-fg-secondary">
              {line}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-5 space-y-4">
        <Field id="wizard-email" label="Email address">
          <Input
            id="wizard-email"
            type="email"
            value={email}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            placeholder="you@example.com"
            onChange={(event) => onEmailChange(event.target.value)}
          />
        </Field>

        <Field
          id="wizard-password"
          label={preset.passwordName}
          helper={
            preset.passwordUrl
              ? // The scheme is there for the link, not for reading.
                `From ${preset.passwordUrl.replace(/^https:\/\//, "")} — not the password you type into the website.`
              : undefined
          }
        >
          <div className="relative">
            <Input
              id="wizard-password"
              type={reveal ? "text" : "password"}
              value={password}
              autoComplete="off"
              placeholder={preset.passwordPlaceholder || undefined}
              className="pr-8 font-mono"
              onChange={(event) => {
                setPassword(event.target.value);
                setProblem(null);
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
          {preset.passwordUrl && (
            <Button asChild variant="secondary" size="sm">
              <a
                href={preset.passwordUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink className="size-3.5" strokeWidth={1.5} />
                {preset.passwordUrlLabel}
              </a>
            </Button>
          )}
        </Field>

        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
          className="text-[12px] text-fg-tertiary hover:text-fg-secondary"
        >
          More settings
        </button>

        {advanced && (
          <div className="space-y-4">
            <Field
              id="wizard-username"
              label="Username"
              helper="Only if your provider signs you in with something other than your address."
            >
              <Input
                id="wizard-username"
                value={username}
                placeholder={email || "Same as the email address"}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <div className="grid grid-cols-[1fr_5rem] gap-3">
              <Field id="wizard-imap-host" label="Incoming server (IMAP)">
                <Input
                  id="wizard-imap-host"
                  value={imapHost}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => setImapHost(event.target.value)}
                />
              </Field>
              <Field id="wizard-imap-port" label="Port">
                <Input
                  id="wizard-imap-port"
                  inputMode="numeric"
                  value={imapPort}
                  className="font-mono"
                  onChange={(event) => setImapPort(event.target.value)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-[1fr_5rem] gap-3">
              <Field id="wizard-smtp-host" label="Outgoing server (SMTP)">
                <Input
                  id="wizard-smtp-host"
                  value={smtpHost}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => setSmtpHost(event.target.value)}
                />
              </Field>
              <Field id="wizard-smtp-port" label="Port">
                <Input
                  id="wizard-smtp-port"
                  inputMode="numeric"
                  value={smtpPort}
                  className="font-mono"
                  onChange={(event) => setSmtpPort(event.target.value)}
                />
              </Field>
            </div>
          </div>
        )}

        <div role="status" aria-live="polite">
          {problem && <p className="text-[12px] leading-4 text-danger">{problem}</p>}

          {create.isError && (
            <div>
              <p className="text-[12px] leading-4 text-danger">
                {friendlyError(errorText(create.error))}
              </p>
              <TechnicalDetails raw={errorText(create.error)} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 flex items-center gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          <ArrowLeft className="size-4" strokeWidth={1.5} />
          Back
        </Button>
        <Button
          type="button"
          disabled={busy}
          aria-busy={create.isPending || undefined}
          onClick={connect}
        >
          {create.isPending && <Spinner />}
          {create.isPending ? "Connecting…" : "Connect"}
        </Button>
        <button
          type="button"
          onClick={onDone}
          className="ml-auto text-[12px] text-fg-tertiary hover:text-fg-secondary"
        >
          {connected > 0 ? "Already done" : "Later"}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* step 3 — done                                                              */
/* -------------------------------------------------------------------------- */

function DoneStep({
  mailboxes,
  host,
  onFinish,
  onConnectAgent,
}: {
  mailboxes: number;
  host: string;
  onFinish: () => void;
  onConnectAgent: () => void;
}) {
  return (
    <section aria-labelledby="wizard-step-3">
      <h1
        id="wizard-step-3"
        className="text-[15px] leading-5 font-semibold tracking-[var(--tracking-tight)] text-fg"
      >
        You&rsquo;re set
      </h1>
      <p className="mt-1.5 text-[13px] leading-[18px] text-fg-secondary">
        {mailboxes === 0
          ? "No mailbox yet — you can add one from the sidebar whenever you like."
          : `${mailboxes} ${mailboxes === 1 ? "mailbox is" : "mailboxes are"} connected${
              host ? ` through ${host}` : ""
            }.`}
      </p>

      <div className="mt-6 rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-3.5">
        <div className="flex items-start gap-2.5">
          <Plug
            aria-hidden="true"
            className="mt-[2px] size-4 shrink-0 text-fg-tertiary"
            strokeWidth={1.5}
          />
          <div className="min-w-0">
            <p className="text-[13px] leading-[18px] font-medium text-fg">
              Let an agent use it
            </p>
            <p className="mt-1 text-[13px] leading-[18px] text-fg-secondary">
              Claude Code, Claude Desktop and Cursor can read, draft, and send
              from these mailboxes. Drafting is the default; sending needs the
              send tool.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2.5"
              onClick={onConnectAgent}
            >
              Connect your agent
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-8">
        <Button type="button" onClick={onFinish}>
          Open my inbox
        </Button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

/** Mirrors the server's isLocalHostHeader: loopback names and addresses only. */
function isLoopbackUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

/**
 * "This page is served by that server", the way the server itself judges it:
 * an exact origin match, or two loopback names on the same port — a browser at
 * localhost:8787 and a config that says 127.0.0.1:8787 are the same process.
 */
function isSameServer(a: string, b: string): boolean {
  const left = normalizeBaseUrl(a);
  const right = normalizeBaseUrl(b);
  if (left === right) return true;
  if (!isLoopbackUrl(left) || !isLoopbackUrl(right)) return false;
  try {
    return new URL(left).port === new URL(right).port;
  } catch {
    return false;
  }
}

/** The server normalises an alias exactly this way (service.ts:49). */
function aliasFor(email: string): string {
  const local = email.trim().split("@")[0] ?? "";
  const alias = local.toLowerCase().replace(/\s+/g, "-");
  return alias || "mailbox";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function describe(error: unknown, host: string): string {
  if (error instanceof ApiError) {
    if (error.kind === "forbidden-origin" || error.kind === "cors") {
      return "The server is up but will not accept requests from this page's address.";
    }
    if (error.kind === "lna-denied") {
      return "Your browser blocked the request to your own computer. Allow it when Chrome asks, then press Check again.";
    }
    if (error.kind === "mixed-content") {
      return "Your browser blocks this page from reaching a plain http address. Open mailmux at its own address instead.";
    }
  }
  return `Nothing answered at ${host}.`;
}

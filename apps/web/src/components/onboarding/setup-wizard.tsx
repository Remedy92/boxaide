"use client";

import * as React from "react";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Laptop,
  Mail,
  Plug,
  Sparkle,
} from "lucide-react";
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
import { ApiError, friendlyError, serverSentence } from "@/lib/api/errors";
import { getApiHealth, getHealth, getLocalBootstrap } from "@/lib/api/endpoints";
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
  type ProviderPreset,
} from "@/lib/constants";
import { googleCallbackUri } from "@/components/calendar/add-calendar-dialog";
import { OptionButton } from "@/components/calendar/option-button";
import { useCreateAccount } from "@/lib/hooks/use-account-mutations";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useAgent } from "@/lib/hooks/use-agent";
import { useApp } from "@/lib/hooks/use-app-state";
import {
  localCalendarOffer,
  useCalendarAccounts,
  useConnectLocalCalendar,
  useConnectMailboxCalendar,
  useReusableMailboxes,
  useStartGoogleCalendar,
} from "@/lib/hooks/use-calendar";
import { useSettings, useUpdateSettings } from "@/lib/hooks/use-settings";
import { hostLabel, isValidBaseUrl, normalizeBaseUrl } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { takeDesktopBootstrapCapability } from "@/lib/desktop-bootstrap";

/**
 * First run, for someone who has never configured a mail client.
 *
 * Four steps, in the order the product actually needs them: reach the server,
 * add one mailbox, add the calendar behind it, done. It is a full-screen surface rather than a dialog
 * because there is nothing behind it worth showing — with no token there is no
 * mail to look at.
 *
 * It writes exactly three things: the server URL and token into localStorage
 * (through useUpdateSettings, which purges the query cache when either
 * changes), one mailbox through POST /api/accounts, and — only if asked — one
 * calendar through the same one-click routes the add-calendar dialog uses.
 *
 * /api/local-bootstrap is called only when the desktop shell supplied a
 * one-time capability in the URL fragment. Served in a normal browser, a
 * human pastes the token even when the page itself came from loopback.
 */

type StepId = 1 | 2 | 3 | 4 | 5;

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
            Boxaide
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            {([1, 2, 3, 4, 5] as const).map((index) => (
              <span
                key={index}
                aria-hidden="true"
                className={cn(
                  "h-[3px] w-6 rounded-[var(--radius-full)] transition-colors duration-[var(--dur-enter)]",
                  index <= step ? "bg-accent" : "bg-border-strong",
                )}
              />
            ))}
            <span className="sr-only">Step {step} of 5</span>
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
            <CalendarStep onBack={() => setStep(2)} onDone={() => setStep(4)} />
          )}
          {step === 4 && (
            <WorkspaceStep
              crm={app.crm}
              onChoose={(value) => {
                app.setCrm(value);
                setStep(5);
              }}
              onBack={() => setStep(3)}
            />
          )}
          {step === 5 && (
            <DoneStep
              crm={app.crm}
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
  /* The address box is off by default. It is the answer to a question almost
     nobody has — Boxaide runs on one computer, at one address, and the probe
     below already knows it. It appears when someone says it is wrong. */
  const [showAddress, setShowAddress] = React.useState(false);
  /* "detecting" is the first render: one quiet line while the page finds and
     signs into its own server. Most people never see the form below — it is
     the fallback for a remotely hosted page or a server that is not running,
     and those are the only audiences the address and token fields have. */
  const [phase, setPhase] = React.useState<"detecting" | "manual">("detecting");
  const [bootstrapCapability] = React.useState(takeDesktopBootstrapCapability);

  /* The address this page was served from. When Boxaide serves its own build,
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
        message: "That does not look like a full address. It should start with http://.",
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
     this page is served from. Served by Boxaide itself, the first probe already
     succeeds and step one passes before the heading has been read. Deployed to
     a static host, the page origin is not a mail server and adopting it would
     be a confident wrong answer. */
  /* Desktop capability only: same-origin loopback is not identity because any
     local process can call it. The shell places an unguessable, one-use secret
     in the fragment; the browser strips it immediately and presents it here.
     Failure is silent — manual paste remains the browser fallback. */
  const adoptLocalToken = React.useCallback(
    async (url: string): Promise<boolean> => {
      setAuth({ status: "checking" });
      try {
        if (!bootstrapCapability) return false;
        const boot = await getLocalBootstrap(
          { baseUrl: url, token: "" },
          bootstrapCapability,
        );
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
    [bootstrapCapability, update],
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

  /**
   * The whole of step one, when it can be done without a human: find a live
   * server, then sign in with a token that is already ours to have. It runs on
   * mount and again behind the "Look again" button, which is the only control
   * this screen needs while Boxaide is simply not started yet.
   *
   * `alive` reports whether it found the seam a human has to close, so the
   * caller can leave the spinner up on success rather than flashing the form.
   */
  const detect = React.useCallback(
    async (alive: () => boolean): Promise<void> => {
      const stored = settings.baseUrl;
      let live: string | null = null;
      if (stored && (await probeRef.current(stored))) {
        live = normalizeBaseUrl(stored);
      }
      if (!live && alive() && pageOrigin && pageOrigin !== normalizeBaseUrl(stored)) {
        if (await probeRef.current(pageOrigin)) {
          if (alive()) setBaseUrl(pageOrigin);
          live = pageOrigin;
        }
      }
      if (alive() && live) {
        // Signed in without a human: a still-valid stored token, or the
        // server's own page vouching for itself. Either way there is no
        // decision left on this screen, so it does not appear.
        if (settings.token) {
          if (await verifyStoredRef.current(live, settings.token)) {
            if (alive()) onDoneRef.current();
            return;
          }
        } else if (pageOrigin && isSameServer(pageOrigin, live)) {
          if (await adoptRef.current(pageOrigin)) {
            if (alive()) onDoneRef.current();
            return;
          }
        }
      }
      if (alive()) setPhase("manual");
    },
    [pageOrigin, settings.baseUrl, settings.token],
  );
  const detectRef = React.useRef(detect);
  React.useEffect(() => {
    detectRef.current = detect;
  }, [detect]);

  React.useEffect(() => {
    let cancelled = false;
    void detectRef.current(() => !cancelled);
    return () => {
      cancelled = true;
    };
    // Once, on mount, through the ref: re-probing on every keystroke would
    // hammer a server that is not there.
  }, []);

  /**
   * "Look again": probe the address in hand — the detected one, or one typed
   * into the box below. A server that is this page's own origin still hands
   * over its token without being asked, so someone who starts Boxaide and
   * presses this never sees the token field at all.
   */
  const look = async () => {
    setAuth({ status: "idle" });
    const reachable = await runProbe(baseUrl);
    if (!reachable) return;
    if (pageOrigin && isSameServer(pageOrigin, baseUrl)) {
      if (await adoptLocalToken(normalizeBaseUrl(baseUrl))) onDone();
    }
  };

  const verify = async () => {
    const reachable = await runProbe(baseUrl);
    if (!reachable) return;
    if (!token.trim()) {
      setAuth({
        status: "fail",
        message:
          "Paste the connection code first — Boxaide shows it where you started it.",
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
      // Signed in is the whole point of this screen. A second button to press
      // afterwards is a step, not a confirmation.
      onDone();
    } catch (error) {
      setAuth({
        status: "fail",
        message:
          error instanceof ApiError && error.kind === "unauthorized"
            ? "That code did not match. Copy the whole line again, with no spaces."
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

  /* Two screens, not one form. Either Boxaide is running and the only thing
     missing is the line it printed, or it is not running and no field on this
     page can fix that. Showing both boxes in both cases is what made this look
     like configuration. */
  const found = probe.status === "ok";
  const busy = auth.status === "checking" || probe.status === "checking";
  /* This page came off a server on this machine, so the app is on this machine
     — it is just not running. Offering a download to someone who already has
     it installed is noise, and worse, it reads as "your copy is broken". */
  const installed = pageOrigin !== null && isLoopbackUrl(pageOrigin);

  return (
    <section aria-labelledby="wizard-step-1">
      <h1
        id="wizard-step-1"
        className="text-[15px] leading-5 font-semibold tracking-[var(--tracking-tight)] text-fg"
      >
        {found ? "Let this page in" : "Boxaide isn’t open yet"}
      </h1>
      <p className="mt-1.5 text-[13px] leading-[18px] text-fg-secondary">
        {found
          ? "Boxaide is open on this computer. It shows a code when it starts, and this page needs that code before it can show your mail."
          : installed
            ? "Boxaide is an app on this computer, and it is not running. Open it, then press Try again."
            : "Boxaide is an app you open on your own computer. Your mail stays there. Get it below, open it, and this page finds it by itself."}
      </p>

      <div className="mt-6 space-y-4">
        {found ? (
          <>
            {probe.fixture && (
              <p className="text-[12px] leading-4 text-warning">
                It is running in demo mode, so the mail you will see is made up.
              </p>
            )}

            <Field
              id="wizard-token"
              label="Connection code"
              helper="Boxaide shows this code where you started it, on the line that begins “bearer token:”. Copy the whole line."
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
                  placeholder="Paste it here"
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
          </>
        ) : (
          probe.status === "fail" && (
            <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-3.5">
              <p className="text-[12px] leading-4 text-fg-secondary">
                {probe.message}
              </p>
              <TechnicalDetails raw={probe.raw} />
            </div>
          )
        )}

        <div role="status" aria-live="polite">
          {auth.status === "ok" && (
            <p className="flex items-center gap-1.5 text-[12px] text-success">
              <StatusDot tone="success" />
              Connected — Boxaide {auth.version}
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

        {/* The address of the machine Boxaide runs on. Hidden until someone
            says the found one is wrong, because for everyone else it is the
            answer to a question they never asked. */}
        {showAddress ? (
          <div className="space-y-3">
            <Field
              id="wizard-base-url"
              label="Where Boxaide is running"
              helper={
                sameOrigin
                  ? "This is the address you are reading this page on."
                  : "The address Boxaide printed when it started."
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
            {/* The command, for the one audience that has a terminal open
                already. It is true for them and meaningless to everyone else,
                which is why it lives behind the same link as the address. */}
            {!found && (
              <p className="text-[12px] leading-4 text-fg-tertiary">
                Running it from a terminal? Start it there with{" "}
                <code className="font-mono text-fg-secondary">boxaide serve</code>
                , then press Try again.
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAddress(true)}
            className="text-[12px] text-fg-tertiary hover:text-fg-secondary"
          >
            {found ? `Not ${hostLabel(baseUrl)}?` : "It runs somewhere else"}
          </button>
        )}
      </div>

      <div className="mt-8 flex items-center gap-2">
        <Button
          type="button"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void (found ? verify() : look())}
        >
          {busy && <Spinner />}
          {found ? "Connect" : "Try again"}
        </Button>
        {/* The one thing that actually helps a visitor with no app: the
            download page, which already picks the right file for them. */}
        {!found && !installed && (
          <Button asChild variant="secondary">
            <a href="/install">
              <Download className="size-4" strokeWidth={1.5} />
              Get Boxaide
            </a>
          </Button>
        )}
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
    if (guess) {
      if (guess.id !== preset.id) applyPreset(guess);
      return;
    }
    // A domain no preset claims: guess imap./smtp. in front of it rather than
    // leaving imap.gmail.com sitting under someone's company address. Connect
    // tests the guess, so a wrong one costs one failed login.
    const hosts = guessHostsForEmail(value);
    if (!hosts) return;
    const other = PROVIDER_PRESETS.find((entry) => entry.id === "other");
    if (other && preset.id !== "other") applyPreset(other);
    setImapHost(hosts.imapHost);
    setImapPort(String(DEFAULT_IMAP_PORT));
    setSmtpHost(hosts.smtpHost);
    setSmtpPort(String(DEFAULT_SMTP_PORT));
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
      setProblem("Two more details are needed from your email provider. They are under More settings.");
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
        alias: aliasForEmail(email),
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
        Your password is encrypted and stays in Boxaide&rsquo;s data folder on
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
/* step 3 — the calendar behind that mailbox                                  */
/* -------------------------------------------------------------------------- */

/**
 * The calendar, asked for at the one moment it is nearly free.
 *
 * A mailbox was connected on the step before, and its password is already
 * stored and already known to work — so for iCloud and Fastmail the calendar
 * behind it is one button with nothing to type. On a Mac the calendars macOS
 * already holds are another. Both come from the server, because what this
 * machine can offer is a fact about the machine, not about this page.
 *
 * Every row here is one click, and the step itself is one click to leave. That
 * is deliberate: a calendar is optional in a way a mailbox is not, and a wizard
 * that stalls someone in front of an OAuth console before they have ever seen
 * their inbox costs more than the calendar is worth.
 *
 * The full CalDAV form is NOT here. Someone whose provider needs a typed server
 * address is someone who can add it from the sidebar afterwards, and the dialog
 * that does it is complete.
 */
function CalendarStep({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: () => void;
}) {
  const settings = useSettings();
  const agent = useAgent();
  const accounts = useCalendarAccounts();
  const mailboxes = useReusableMailboxes();
  const connectLocal = useConnectLocalCalendar();
  const connectMailbox = useConnectMailboxCalendar();
  const startGoogle = useStartGoogleCalendar();
  /* The Google brief was posted to the agent. Not a success claim on its own —
     agent.error is read live below, and only silence there means it landed. */
  const [handed, setHanded] = React.useState(false);
  /* Set only when window.open was blocked, so the approval page becomes a link
     the person clicks themselves. */
  const [blockedUrl, setBlockedUrl] = React.useState<string | null>(null);
  /* The duplicate the server declined to create unasked. Same shape as the
     add-calendar dialog's, and for the same reason. */
  const [confirm, setConfirm] = React.useState<{
    message: string;
    retry: () => void;
  } | null>(null);

  /* Both lists have answered. Until then nothing about the offer is known, so
     nothing about it is drawn — the same rule the dialog follows. */
  const known = !accounts.isLoading && !mailboxes.isLoading;
  const calendars = accounts.data?.accounts ?? [];
  const local = localCalendarOffer(accounts.data);
  const reusable = mailboxes.data ?? [];
  const googleBuiltIn = accounts.data?.googleBuiltIn === true;
  /* What the server says it will send Google. The reconstruction behind it is
     for a server too old to state its own; this wizard always has a base URL by
     now, since step 1 is what wrote it. */
  const redirectUri =
    accounts.data?.googleRedirectUri ?? googleCallbackUri(settings.baseUrl, "");

  /**
   * Whether handing the Google job to an agent would reach anybody.
   *
   * The agent is paired on the LAST step of this wizard, so at this point
   * there is usually nothing on the other end: the brief would be written into
   * a conversation no one is reading, and the row would be the only Google
   * offer on Windows and Linux. Offered only once an agent has actually called
   * in — someone who paired one before running the wizard, or who came back
   * here later.
   */
  const agentReachable =
    agent.connection !== "unsupported" &&
    (agent.presence.listening ||
      agent.presence.launchedAgent !== null ||
      agent.presence.lastSeenAt !== null);

  const busy =
    connectLocal.isPending ||
    connectMailbox.isPending ||
    startGoogle.isPending ||
    agent.sending;

  const connected = (name: string) => {
    toast.success(`Connected ${name}`);
    onDone();
  };

  /**
   * The duplicate question, asked exactly as the dialog asks it: a 409 means the
   * server sees a calendar this Mac probably already holds, and the way past it
   * is the same call with the confirmation attached.
   */
  const onConnectError = (error: unknown, retry: () => void): void => {
    if (!(error instanceof ApiError) || error.status !== 409) return;
    setConfirm({ message: serverSentence(error), retry });
  };

  const connectLocalNow = (confirmOverlap: boolean) =>
    connectLocal.mutate(confirmOverlap, {
      onSuccess: (account) => connected(account.alias),
      onError: (error) =>
        onConnectError(error, () => {
          setConfirm(null);
          connectLocalNow(true);
        }),
    });

  const connectMailboxNow = (mailAccountId: string, confirmOverlap: boolean) =>
    connectMailbox.mutate(
      { mailAccountId, confirmOverlap },
      {
        onSuccess: (account) => connected(account.alias),
        onError: (error) =>
          onConnectError(error, () => {
            setConfirm(null);
            connectMailboxNow(mailAccountId, true);
          }),
      },
    );

  /**
   * The Windows and Linux Google path, which has no short version: Google
   * withdrew CalDAV app passwords, and with no built-in OAuth client the person
   * has to create one in their own Google Cloud project. That is a console, six
   * screens and two secrets — so it is handed to the agent as a written brief
   * with the redirect URI already in it, the same way every other long job in
   * this app is handed over. Offered only when an agent is actually there to
   * read it; see agentReachable.
   *
   * The wizard does not advance itself afterwards: nothing is connected yet,
   * and saying otherwise would be a lie. The conversation is queued server-side
   * and is waiting whenever the agent is opened.
   */
  const askAgent = async () => {
    await agent.send(googleSetupBrief(redirectUri));
    setHanded(true);
  };

  return (
    <section aria-labelledby="wizard-step-3">
      <h1
        id="wizard-step-3"
        className="text-[15px] leading-5 font-semibold tracking-[var(--tracking-tight)] text-fg"
      >
        Add your calendar
      </h1>
      <p className="mt-1.5 text-[13px] leading-[18px] text-fg-secondary">
        So your agent can see your day and send real invitations. Skip it and
        everything else still works.
      </p>

      {!known ? (
        <p className="mt-6 flex items-center gap-2 text-[13px] leading-[18px] text-fg-tertiary">
          <Spinner />
          Checking what this machine can connect&hellip;
        </p>
      ) : (
        <div className="mt-6 space-y-2">
          {/* macOS refused once already, and only System Settings can undo
              that — so this is a sentence, not a button that could only fail. */}
          {local.note && (
            <p className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-3 text-[12px] leading-4 text-fg-secondary">
              {local.note}
            </p>
          )}

          {local.offer && (
            <OptionButton
              icon={<Laptop className="size-4" strokeWidth={1.5} />}
              title="Use the calendars on this Mac"
              detail="Reads the calendars already set up in Apple Calendar. macOS will ask your permission once."
              pending={connectLocal.isPending}
              pendingLabel="Waiting for the macOS permission dialog…"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                connectLocalNow(false);
              }}
            />
          )}

          {reusable.map((mailbox) => (
            <OptionButton
              key={mailbox.mailAccountId}
              icon={<Mail className="size-4" strokeWidth={1.5} />}
              title={`Add your ${mailbox.provider} calendar`}
              detail={`Uses the password you just gave for ${mailbox.email}. Nothing to type.`}
              caution={
                mailbox.onThisMac
                  ? `This Mac already has ${mailbox.onThisMac}, so these events may appear twice.`
                  : undefined
              }
              pending={
                connectMailbox.isPending &&
                typeof connectMailbox.variables === "object" &&
                connectMailbox.variables.mailAccountId === mailbox.mailAccountId
              }
              pendingLabel="Connecting…"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                connectMailboxNow(mailbox.mailAccountId, false);
              }}
            />
          ))}

          {googleBuiltIn ? (
            <OptionButton
              icon={<ExternalLink className="size-4" strokeWidth={1.5} />}
              title="Continue with Google"
              detail="Opens Google's approval page in a new tab. Nothing to set up first."
              pending={startGoogle.isPending}
              pendingLabel="Opening Google…"
              disabled={busy}
              onClick={() =>
                startGoogle.mutate(
                  {},
                  {
                    onSuccess: (result) => {
                      // This is no longer inside the click that started it, so
                      // a popup blocker will refuse it. The step must not
                      // advance on a tab that was never opened.
                      const opened = window.open(
                        result.authUrl,
                        "_blank",
                        "noopener,noreferrer",
                      );
                      if (!opened) {
                        setBlockedUrl(result.authUrl);
                        return;
                      }
                      toast.success("Approve Boxaide in the new tab", {
                        description:
                          "The calendar shows up once Google has sent you back.",
                      });
                      onDone();
                    },
                  },
                )
              }
            />
          ) : agentReachable ? (
            <OptionButton
              icon={<Sparkle className="size-4" strokeWidth={1.5} />}
              title="Get help connecting Google Calendar"
              detail="Google needs a few steps in its own website first. Boxaide writes them into your assistant chat, and it talks you through them."
              pending={agent.sending}
              pendingLabel="Sending it to your assistant…"
              disabled={busy}
              onClick={() => void askAgent()}
            />
          ) : null}

          {/* Nothing this machine can offer in one click. Saying so beats an
              empty panel above a skip link that does not look like a way out. */}
          {!local.offer &&
            reusable.length === 0 &&
            !googleBuiltIn &&
            !agentReachable && (
              <p className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-3 text-[13px] leading-[18px] text-fg-secondary">
                Nothing on this machine can be connected in one press. You can
                add a calendar any time from Calendar → Add calendar, which asks
                for your address and an app password.
              </p>
            )}
        </div>
      )}

      <div role="status" aria-live="polite" className="mt-4 space-y-1.5">
        {handed && !agent.error && (
          <p className="text-[13px] leading-[18px] text-fg-secondary">
            The steps are in your assistant chat, in the Chat pane. No calendar
            is connected yet — open that chat and it will take you through it.
          </p>
        )}

        {blockedUrl && (
          <div className="space-y-2">
            <p className="text-[13px] leading-[18px] text-fg-secondary">
              Your browser blocked the new tab. Open Google&rsquo;s approval
              page yourself:
            </p>
            <Button asChild variant="secondary" size="sm">
              <a href={blockedUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-3.5" strokeWidth={1.5} />
                Open Google&rsquo;s approval page
              </a>
            </Button>
          </div>
        )}

        {/* The server writes these sentences itself — which System Settings
            pane to open, which stored password was refused — so they are shown
            as written. See serverSentence. */}
        {confirm ? (
          <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-3">
            <p className="text-[12px] leading-4 text-warning">{confirm.message}</p>
            <div className="mt-2 flex gap-1.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={confirm.retry}
              >
                Add it anyway
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          (connectLocal.error || connectMailbox.error) && (
            <p className="text-[12px] leading-4 text-danger">
              {serverSentence(connectLocal.error ?? connectMailbox.error)}
            </p>
          )
        )}

        {startGoogle.isError && (
          <div>
            <p className="text-[12px] leading-4 text-danger">
              {friendlyError(errorText(startGoogle.error))}
            </p>
            <TechnicalDetails raw={errorText(startGoogle.error)} />
          </div>
        )}

        {agent.error && (
          <p className="text-[12px] leading-4 text-danger">{agent.error}</p>
        )}
      </div>

      <div className="mt-8 flex items-center gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          <ArrowLeft className="size-4" strokeWidth={1.5} />
          Back
        </Button>
        {/* A real button, the same weight as Back. On a machine where none of
            the rows above apply this is the correct move, and the least
            visible control on the screen is the wrong place to put it. */}
        <Button
          type="button"
          variant="secondary"
          className="ml-auto"
          disabled={busy}
          onClick={onDone}
        >
          {handed || calendars.length > 0 ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* step 4 — mail, or mail and a CRM                                           */
/* -------------------------------------------------------------------------- */

/**
 * The one question this wizard asks that is not about connecting something.
 *
 * It is asked here, before the app is ever seen, because the honest answer is
 * different for the two people who install Boxaide: one wants a mail client
 * and one wants the mail client that also tracks who they are talking to.
 * Showing both and letting the first person ignore half the sidebar is the
 * thing this step exists to avoid.
 *
 * Choosing is the only way forward — both cards advance — so there is no
 * default hiding behind a Continue button.
 */
function WorkspaceStep({
  crm,
  onChoose,
  onBack,
}: {
  crm: boolean;
  onChoose: (value: boolean) => void;
  onBack: () => void;
}) {
  const options = [
    {
      value: false,
      title: "Mail",
      body: "An inbox, drafts, folders and your agent. Nothing else in the sidebar.",
    },
    {
      value: true,
      title: "Mail and CRM",
      body: "Everything above, plus People, a deal Pipeline, and an Outreach queue you approve.",
    },
  ];

  /* The highlighted card, which is NOT the committed answer: arrows move it,
     and only Enter, Space or a click commits through onChoose. Without this
     the arrow handler below would advance the wizard on every keypress. */
  const [choice, setChoice] = React.useState(crm);
  const optionRefs = React.useRef(new Map<string, HTMLButtonElement>());

  return (
    <section aria-labelledby="wizard-step-4">
      <h1
        id="wizard-step-4"
        className="text-[15px] leading-5 font-semibold tracking-[var(--tracking-tight)] text-fg"
      >
        What do you want Boxaide to be?
      </h1>
      <p className="mt-1.5 text-[13px] leading-[18px] text-fg-secondary">
        You can change this later in Settings, and nothing is thrown away
        either way.
      </p>

      {/* A real APG radio group, the same shape as the provider row above: one
          tab stop, arrows move the highlight and the focus. role="radio"
          without a roving tabindex and arrow handling makes each card its own
          tab stop and leaves Arrow keys dead (4.1.2). */}
      <div
        role="radiogroup"
        aria-label="What Boxaide is"
        className="mt-6 space-y-2"
        onKeyDown={(event) => {
          const delta =
            event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 1
              : event.key === "ArrowLeft" || event.key === "ArrowUp"
                ? -1
                : 0;
          if (delta === 0) return;
          event.preventDefault();
          const at = options.findIndex((entry) => entry.value === choice);
          const next =
            options[
              (Math.max(at, 0) + delta + options.length) % options.length
            ];
          setChoice(next.value);
          optionRefs.current.get(next.title)?.focus();
        }}
      >
        {options.map((option) => (
          <button
            key={option.title}
            ref={(node) => {
              if (node) optionRefs.current.set(option.title, node);
              else optionRefs.current.delete(option.title);
            }}
            type="button"
            role="radio"
            aria-checked={choice === option.value}
            tabIndex={choice === option.value ? 0 : -1}
            onClick={() => onChoose(option.value)}
            className={cn(
              "w-full rounded-[var(--radius-md)] border p-3.5 text-left",
              "transition-colors duration-[var(--dur-fast)]",
              choice === option.value
                ? "border-accent bg-accent-subtle"
                : "border-border-control bg-surface-2 hover:bg-surface-hover",
            )}
          >
            <p
              className={cn(
                "text-[13px] leading-[18px] font-medium",
                choice === option.value ? "text-accent" : "text-fg",
              )}
            >
              {option.title}
            </p>
            <p className="mt-1 text-[13px] leading-[18px] text-fg-secondary">
              {option.body}
            </p>
          </button>
        ))}
      </div>

      <div className="mt-8 flex items-center gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" strokeWidth={1.5} />
          Back
        </Button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* step 5 — done                                                              */
/* -------------------------------------------------------------------------- */

function DoneStep({
  crm,
  mailboxes,
  host,
  onFinish,
  onConnectAgent,
}: {
  crm: boolean;
  mailboxes: number;
  host: string;
  onFinish: () => void;
  onConnectAgent: () => void;
}) {
  return (
    <section aria-labelledby="wizard-step-5">
      <h1
        id="wizard-step-5"
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
      {/* Says back what was just chosen, in the words of the sidebar it is
          about to produce. It is the one step whose effect is invisible until
          the app opens. */}
      <p className="mt-1.5 text-[13px] leading-[18px] text-fg-secondary">
        {crm
          ? "Set up as mail and a CRM. Settings can drop it to mail only."
          : "Set up as a mail client. Settings can add the CRM back."}
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
      return "Your browser blocks this page from reaching a plain http address. Open Boxaide at its own address instead.";
    }
  }
  return `Nothing answered at ${host}.`;
}

/**
 * The brief the agent is handed for the long Google path.
 *
 * Written as an instruction to the agent rather than as a question from the
 * person, because the person's part is "do this for me" — they pressed one
 * button. The redirect URI is in it because it is the one value the agent
 * cannot look up and the one Google rejects the sign-in over, character for
 * character.
 */
function googleSetupBrief(redirectUri: string): string {
  return [
    "Walk me through connecting my Google Calendar to Boxaide.",
    "",
    "This install has no built-in Google client, so I have to create my own OAuth client. Take me through it one step at a time and wait for me after each one:",
    "",
    "1. Create a project, or pick an existing one, at console.cloud.google.com.",
    "2. Enable the Google Calendar API for that project.",
    "3. Configure the OAuth consent screen: External, with my own Google address added as a test user.",
    "4. Create an OAuth client of type Web application, and add this authorised redirect URI to it exactly as written:",
    `   ${redirectUri}`,
    "5. Tell me to open Calendar in Boxaide, press Add calendar, open Continue with Google, and paste the client ID and secret from that client.",
    "",
    "Explain what each screen is for as we go, and ask me what I am seeing if the console does not match what you expect.",
  ].join("\n");
}

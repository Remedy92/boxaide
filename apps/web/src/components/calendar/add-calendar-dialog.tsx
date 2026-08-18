"use client";

import * as React from "react";
import { CircleCheck, CircleAlert, ExternalLink, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { CopyBlock, Field, Spinner, TechnicalDetails } from "@/components/atoms";
import { Segmented } from "@/components/calendar/segmented";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { normalizeBaseUrl } from "@/lib/api/client";
import { friendlyError } from "@/lib/api/errors";
import {
  useCalendarAccounts,
  useCreateCalDavAccount,
  useStartGoogleCalendar,
  useTestCalDavAccount,
} from "@/lib/hooks/use-calendar";
import { useSettings } from "@/lib/hooks/use-settings";

/**
 * One row of choices, not a provider tab over a provider list. Nobody knows
 * their CalDAV address, so the row names the four things people actually have
 * and fills the address in — the same move the mailbox wizard makes with IMAP
 * hosts. Google is on the same row because from the outside it is the same
 * question: "which calendar?"
 */
type PresetId = "icloud" | "fastmail" | "nextcloud" | "other" | "google";

type CalDavPreset = {
  id: Exclude<PresetId, "google">;
  label: string;
  /** Prefilled into the form. Empty means the person has to know it. */
  serverUrl: string;
  placeholder: string;
  passwordHelper: string;
  passwordUrl?: string;
  passwordUrlLabel?: string;
};

const CALDAV_PRESETS: readonly CalDavPreset[] = [
  {
    id: "icloud",
    label: "iCloud",
    serverUrl: "https://caldav.icloud.com",
    placeholder: "https://caldav.icloud.com",
    passwordHelper:
      "An app-specific password from appleid.apple.com — not your Apple ID password.",
    passwordUrl: "https://appleid.apple.com",
    passwordUrlLabel: "Create an app-specific password",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    serverUrl: "https://caldav.fastmail.com",
    placeholder: "https://caldav.fastmail.com",
    passwordHelper:
      "An app password with calendar access — not your Fastmail password.",
    passwordUrl: "https://app.fastmail.com/settings/security/apps",
    passwordUrlLabel: "Create an app password",
  },
  {
    id: "nextcloud",
    label: "Nextcloud",
    serverUrl: "",
    placeholder: "https://cloud.example.com/remote.php/dav",
    passwordHelper:
      "In Nextcloud: Settings → Security → Create new app password.",
  },
  {
    id: "other",
    label: "Other CalDAV",
    serverUrl: "",
    placeholder: "https://caldav.example.com",
    passwordHelper:
      "Most providers want an app-specific password here, not your account password.",
  },
];

const PRESET_OPTIONS: ReadonlyArray<{ value: PresetId; label: string }> = [
  ...CALDAV_PRESETS.map((entry) => ({
    value: entry.id as PresetId,
    label: entry.label,
  })),
  { value: "google", label: "Google" },
];

/** One line each, in the order they have to be done. */
const GOOGLE_STEPS = [
  "Create a project — or pick one — in the Google Cloud console.",
  "Enable the Google Calendar API for that project.",
  "Configure the OAuth consent screen: External, and add your own address as a test user.",
  "Create an OAuth client of type Web application, and add the redirect URI below to it.",
  "Copy that client's ID and secret into the two fields here.",
];

const GOOGLE_CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";
const GOOGLE_CALENDAR_API_URL =
  "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";

/** The page's own origin, hydration-safe. See the useSyncExternalStore below. */
const NO_SUBSCRIBE = () => () => {};
const CLIENT_ORIGIN = () => window.location.origin;
const SERVER_ORIGIN = () => "";

function parseOrigin(value: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * A GUESS at the redirect URI, for a server too old to state its own.
 *
 * The real value comes from GET /api/calendar/accounts, because only the server
 * knows the address it bound to — and Google answers redirect_uri_mismatch
 * unless the registered string matches that one character for character. This
 * reconstruction is the fallback: the stored server URL, which is where every
 * API call already goes, and this page's own origin behind that.
 *
 * `localhost` is rewritten to `127.0.0.1` because Google treats them as
 * different URIs while a person typing a server address does not, and the
 * server's own default bind is the numeric form.
 *
 * Display only. Nothing is sent to Google from this browser.
 */
export function googleCallbackUri(baseUrl: string, origin: string): string {
  const url = parseOrigin(normalizeBaseUrl(baseUrl)) ?? parseOrigin(origin);
  if (!url) return "";
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return `${url.protocol}//${url.host}/api/calendar/google/callback`;
}

/**
 * Two ways in, and they are genuinely different shapes rather than two tabs
 * over one form.
 *
 * CalDAV is four fields this app can verify and save outright. Google is an
 * OAuth client the person creates in their own Google Cloud project — this app
 * only starts the handshake and hands them the consent URL; the server finishes
 * it after the redirect, which is why saving here connects nothing on its own.
 */
export function AddCalendarDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [presetId, setPresetId] = React.useState<PresetId>("icloud");
  const [caldav, setCaldav] = React.useState(() => blankCaldav("icloud"));
  const [google, setGoogle] = React.useState({
    alias: "",
    clientId: "",
    clientSecret: "",
  });
  const [reveal, setReveal] = React.useState(false);
  const [validation, setValidation] = React.useState<string | null>(null);

  const settings = useSettings();
  /* The same query the view runs, deduped by React Query — one request, two
     readers. Only `googleRedirectUri` is wanted here. */
  const accounts = useCalendarAccounts();
  const test = useTestCalDavAccount();
  const create = useCreateCalDavAccount();
  const startGoogle = useStartGoogleCalendar();

  /* Read through an external store rather than an effect: the page is a static
     export, so window.location is unreadable while it prerenders, and setting
     state on mount to fix that is a cascading render for a string that never
     changes afterwards. Only the fallback needs it — see googleCallbackUri. */
  const origin = React.useSyncExternalStore(
    NO_SUBSCRIBE,
    CLIENT_ORIGIN,
    SERVER_ORIGIN,
  );
  /* What the server says it will send Google, when it says anything. The
     reconstruction is only for a server built before that field. */
  const redirectUri =
    accounts.data?.googleRedirectUri ??
    googleCallbackUri(settings.baseUrl, origin);

  const isGoogle = presetId === "google";
  const preset =
    CALDAV_PRESETS.find((entry) => entry.id === presetId) ?? CALDAV_PRESETS[0];

  const reset = () => {
    setPresetId("icloud");
    setCaldav(blankCaldav("icloud"));
    setGoogle({ alias: "", clientId: "", clientSecret: "" });
    setReveal(false);
    setValidation(null);
    test.reset();
    create.reset();
    startGoogle.reset();
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  /**
   * A preset writes the address and the help text, and nothing else. Every
   * field stays editable — a self-hosted iCloud-shaped setup is somebody's
   * real arrangement, and a locked box would be a dead end for them.
   */
  const choosePreset = (next: PresetId) => {
    setPresetId(next);
    setValidation(null);
    // A previous test was about a different server.
    test.reset();
    if (next === "google") return;
    const chosen = CALDAV_PRESETS.find((entry) => entry.id === next);
    if (!chosen) return;
    setCaldav((value) => ({
      ...value,
      alias: value.alias || defaultAlias(chosen.id),
      serverUrl: chosen.serverUrl,
    }));
  };

  const caldavBody = () => ({
    alias: caldav.alias.trim(),
    serverUrl: caldav.serverUrl.trim(),
    username: caldav.username.trim(),
    password: caldav.password,
  });

  const requireCaldav = (): boolean => {
    const body = caldavBody();
    if (!body.alias) {
      setValidation("Give this calendar a name.");
      return false;
    }
    if (!body.serverUrl) {
      setValidation("Paste the CalDAV address your provider gave you.");
      return false;
    }
    if (!body.username || !body.password) {
      setValidation("A username and an app password are both needed.");
      return false;
    }
    setValidation(null);
    return true;
  };

  const onTest = () => {
    if (!requireCaldav()) return;
    test.mutate(caldavBody());
  };

  const onSaveCaldav = () => {
    if (!requireCaldav()) return;
    create.mutate(caldavBody(), {
      onSuccess: (account) => {
        toast.success(`Connected ${account.alias}`);
        close();
      },
    });
  };

  const onStartGoogle = () => {
    if (!google.alias.trim()) {
      setValidation("Give this calendar a name.");
      return;
    }
    if (!google.clientId.trim() || !google.clientSecret.trim()) {
      setValidation("Both the client ID and the client secret are needed.");
      return;
    }
    setValidation(null);
    startGoogle.mutate(
      {
        alias: google.alias.trim(),
        clientId: google.clientId.trim(),
        clientSecret: google.clientSecret.trim(),
      },
      {
        onSuccess: (result) => {
          window.open(result.authUrl, "_blank", "noopener,noreferrer");
          toast.success("Approve Boxaide in the new tab", {
            description:
              "The calendar shows up here once Google has sent you back.",
          });
          close();
        },
      },
    );
  };

  const busy = create.isPending || test.isPending || startGoogle.isPending;
  const error = isGoogle ? (startGoogle.error ?? null) : (create.error ?? null);

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
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
          if (!(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          if (busy) return;
          if (isGoogle) onStartGoogle();
          else onSaveCaldav();
        }}
      >
        <DialogHeader>
          <DialogTitle className="title-15">Add a calendar</DialogTitle>
          <DialogDescription>
            Boxaide stores these credentials encrypted on your own machine and
            never sends them anywhere else.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>

          <Segmented
            label="Calendar provider"
            options={PRESET_OPTIONS}
            value={presetId}
            onChange={choosePreset}
          />

          {isGoogle ? (
            <div className="space-y-3">
              {/* The instructions, not a hint. Google will not hand out a client
                  without every one of these, and the fourth is the one that
                  fails silently hours later if it is skipped. */}
              <ol className="space-y-2 rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-3.5">
                {GOOGLE_STEPS.map((line, index) => (
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

              <Field
                id="google-redirect"
                label="Authorised redirect URI"
                helper="This is your Boxaide server's own address. Google rejects the sign-in unless it is listed on the client, character for character."
              >
                <CopyBlock value={redirectUri || "…"} label="the redirect URI" />
              </Field>

              <div className="flex flex-wrap gap-1.5">
                <Button asChild variant="secondary" size="sm">
                  <a
                    href={GOOGLE_CALENDAR_API_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <ExternalLink className="size-3.5" strokeWidth={1.5} />
                    Enable the Calendar API
                  </a>
                </Button>
                <Button asChild variant="secondary" size="sm">
                  <a
                    href={GOOGLE_CREDENTIALS_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <ExternalLink className="size-3.5" strokeWidth={1.5} />
                    Create the OAuth client
                  </a>
                </Button>
              </div>

              <Field
                id="google-alias"
                label="Name"
                helper="Shown beside every event from this calendar."
              >
                <Input
                  id="google-alias"
                  value={google.alias}
                  autoComplete="off"
                  placeholder="work"
                  onChange={(event) => {
                    setValidation(null);
                    setGoogle((v) => ({ ...v, alias: event.target.value }));
                  }}
                />
              </Field>

              <Field id="google-client-id" label="Client ID">
                <Input
                  id="google-client-id"
                  value={google.clientId}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => {
                    setValidation(null);
                    setGoogle((v) => ({ ...v, clientId: event.target.value }));
                  }}
                />
              </Field>

              <Field id="google-client-secret" label="Client secret">
                <Input
                  id="google-client-secret"
                  type="password"
                  value={google.clientSecret}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => {
                    setValidation(null);
                    setGoogle((v) => ({ ...v, clientSecret: event.target.value }));
                  }}
                />
              </Field>
            </div>
          ) : (
            <div className="space-y-3">
              <Field
                id="calendar-alias"
                label="Name"
                helper="Shown beside every event from this calendar."
              >
                <Input
                  id="calendar-alias"
                  value={caldav.alias}
                  autoComplete="off"
                  placeholder="personal"
                  onChange={(event) => {
                    setValidation(null);
                    setCaldav((v) => ({ ...v, alias: event.target.value }));
                  }}
                />
              </Field>

              <Field
                id="calendar-server"
                label="Server URL"
                helper={
                  preset.serverUrl
                    ? "Filled in for you. Change it only if your provider gave you a different address."
                    : "The CalDAV address your provider gave you."
                }
              >
                <Input
                  id="calendar-server"
                  value={caldav.serverUrl}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder={preset.placeholder}
                  onChange={(event) => {
                    setValidation(null);
                    setCaldav((v) => ({ ...v, serverUrl: event.target.value }));
                  }}
                />
              </Field>

              <Field
                id="calendar-username"
                label="Username"
                helper="Usually the email address you sign in with."
              >
                <Input
                  id="calendar-username"
                  value={caldav.username}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="you@example.com"
                  onChange={(event) => {
                    setValidation(null);
                    setCaldav((v) => ({ ...v, username: event.target.value }));
                  }}
                />
              </Field>

              <Field
                id="calendar-password"
                label="App password"
                helper={preset.passwordHelper}
              >
                <div className="relative">
                  <Input
                    id="calendar-password"
                    type={reveal ? "text" : "password"}
                    value={caldav.password}
                    autoComplete="off"
                    className="pr-8"
                    onChange={(event) => {
                      setValidation(null);
                      setCaldav((v) => ({ ...v, password: event.target.value }));
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
            </div>
          )}

          <div role="status" aria-live="polite" className="space-y-1.5">
            {validation && (
              <p className="text-[12px] leading-4 text-danger">{validation}</p>
            )}

            {/* The test result, in words. A green button that goes back to grey
                says nothing a second later. */}
            {!isGoogle && test.data && (
              <p
                className={`flex items-start gap-1.5 text-[12px] leading-4 ${
                  test.data.ok ? "text-success" : "text-danger"
                }`}
              >
                {test.data.ok ? (
                  <CircleCheck
                    aria-hidden="true"
                    className="mt-px size-3.5 shrink-0"
                    strokeWidth={1.5}
                  />
                ) : (
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-px size-3.5 shrink-0"
                    strokeWidth={1.5}
                  />
                )}
                {test.data.ok
                  ? "That calendar answered. Nothing is saved yet."
                  : friendlyError(test.data.error ?? "The calendar did not answer.")}
              </p>
            )}

            {(test.isError || error) && (
              <div>
                <p className="text-[12px] leading-4 text-danger">
                  {friendlyError(errorText(test.isError ? test.error : error))}
                </p>
                <TechnicalDetails raw={errorText(test.isError ? test.error : error)} />
              </div>
            )}
          </div>

        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>

          {isGoogle ? (
            <Button
              type="button"
              disabled={busy}
              aria-busy={startGoogle.isPending || undefined}
              onClick={onStartGoogle}
            >
              {startGoogle.isPending && <Spinner />}
              {startGoogle.isPending ? "Opening Google…" : "Continue with Google"}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                aria-busy={test.isPending || undefined}
                onClick={onTest}
              >
                {test.isPending && <Spinner />}
                {test.isPending ? "Testing…" : "Test"}
              </Button>
              <Button
                type="button"
                disabled={busy}
                aria-busy={create.isPending || undefined}
                onClick={onSaveCaldav}
              >
                {create.isPending && <Spinner />}
                {create.isPending ? "Connecting…" : "Add calendar"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The name a preset suggests. Typed over freely; only ever a starting point. */
function defaultAlias(id: CalDavPreset["id"]): string {
  return id === "other" ? "" : id;
}

function blankCaldav(id: PresetId) {
  const preset = CALDAV_PRESETS.find((entry) => entry.id === id);
  return {
    alias: preset ? defaultAlias(preset.id) : "",
    serverUrl: preset?.serverUrl ?? "",
    username: "",
    password: "",
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

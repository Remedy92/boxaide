"use client";

import * as React from "react";
import {
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Laptop,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import { CopyBlock, Field, Spinner, TechnicalDetails } from "@/components/atoms";
import { OptionButton } from "@/components/calendar/option-button";
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
import { friendlyError, needsConfirmation, serverSentence } from "@/lib/api/errors";
import { aliasForEmail, stripPasswordSpaces } from "@/lib/constants";
import {
  localCalendarOffer,
  useCalendarAccounts,
  useConnectLocalCalendar,
  useConnectMailboxCalendar,
  useCreateCalDavAccount,
  useReusableMailboxes,
  useStartGoogleCalendar,
} from "@/lib/hooks/use-calendar";
import { useSettings } from "@/lib/hooks/use-settings";
import { cn } from "@/lib/utils";

/**
 * The chips inside the manual form, and nothing else. They exist because
 * nobody knows their CalDAV address: picking a name fills the address in. They
 * are no longer the first thing the dialog shows, because for most people the
 * address is already known — from this Mac, from a mailbox already connected,
 * or from Google — and typing one is the path of last resort.
 */
type PresetId = "icloud" | "fastmail" | "nextcloud" | "other";

type CalDavPreset = {
  id: PresetId;
  label: string;
  /** Prefilled into the form. Empty means the person has to know it. */
  serverUrl: string;
  placeholder: string;
  passwordHelper: string;
  /** Addresses that give the provider away, so the URL can be derived. */
  domains: readonly string[];
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
    domains: ["icloud.com", "me.com", "mac.com"],
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
    domains: ["fastmail.com", "fastmail.fm", "sent.com", "messagingengine.com"],
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
    domains: [],
  },
  {
    id: "other",
    label: "Other CalDAV",
    serverUrl: "",
    placeholder: "https://caldav.example.com",
    passwordHelper:
      "Most providers want an app-specific password here, not your account password.",
    domains: [],
  },
];

const PRESET_OPTIONS: ReadonlyArray<{ value: PresetId; label: string }> =
  CALDAV_PRESETS.map((entry) => ({ value: entry.id, label: entry.label }));

/**
 * What a typed address says about where its calendar lives, or null while it
 * still says nothing.
 *
 * A domain one of the presets claims gives the whole address away. A finished
 * domain none of them claims is answered with "Other CalDAV" and an EMPTY
 * server field, which is the honest answer: there is deliberately no
 * `caldav.<domain>` guess to match the mailbox form's `imap.<domain>` one,
 * because a guessed IMAP host is right most of the time and a guessed CalDAV
 * path almost never is. Leaving the previous preset's address under a foreign
 * domain would be worse than either — it fails naming a provider the person
 * never chose.
 *
 * A half-typed address returns null so the form holds still while it is typed.
 * Same rule, and the same domain shape, as guessHostsForEmail.
 */
function addressTells(email: string): CalDavPreset | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  const known = CALDAV_PRESETS.find((entry) => entry.domains.includes(domain));
  if (known) return known;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain)) return null;
  return CALDAV_PRESETS.find((entry) => entry.id === "other") ?? null;
}

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
 * Ways in, cheapest first, and only the ones that work on this machine.
 *
 * The order is the whole design. Someone opening this dialog usually already
 * has their calendar somewhere this app can reach without being told anything:
 * in macOS, behind a mailbox whose password is already stored, or behind a
 * Google account. Each of those is one button. The four-field CalDAV form is
 * still here, still complete, but it is the last resort rather than the front
 * door — so it sits behind a disclosure and opens by itself only when nothing
 * else is on offer.
 *
 * What is on offer is a property of the server and the machine, not of this
 * page, so it is read from GET /api/calendar/accounts and the mailbox list.
 * Nothing is rendered until both have answered: a manual form that appears for
 * half a second and is then replaced by a one-click button is worse than a
 * moment of nothing.
 */
export function AddCalendarDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [manual, setManual] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [googleForm, setGoogleForm] = React.useState(false);
  const [presetId, setPresetId] = React.useState<PresetId>("icloud");
  const [form, setForm] = React.useState(() => blankForm());
  const [google, setGoogle] = React.useState({ clientId: "", clientSecret: "" });
  const [reveal, setReveal] = React.useState(false);
  const [validation, setValidation] = React.useState<string | null>(null);
  /* Set only when window.open was blocked. The URL is then the user's own
     link to click, because nothing else in this dialog can get them there. */
  const [blockedUrl, setBlockedUrl] = React.useState<string | null>(null);
  /* The duplicate the server refused to create until it is asked twice.
     `retry` is the same call with the confirmation set, so the sentence and the
     button that answers it never drift apart. */
  const [confirm, setConfirm] = React.useState<{
    message: string;
    retry: () => void;
  } | null>(null);
  /* A chip picked by hand outranks anything a typed address suggests. Only the
     chip row sets it, and only a fresh dialog clears it. */
  const pinned = React.useRef(false);

  const emailRef = React.useRef<HTMLInputElement>(null);
  const passwordRef = React.useRef<HTMLInputElement>(null);
  const serverRef = React.useRef<HTMLInputElement>(null);

  const settings = useSettings();
  /* The same query the view runs, deduped by React Query — one request, two
     readers. This one wants all three capability fields off it. */
  const accounts = useCalendarAccounts();
  const mailboxes = useReusableMailboxes(open);
  const connectLocal = useConnectLocalCalendar();
  const connectMailbox = useConnectMailboxCalendar();
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

  /* Both lists have answered, either with data or with a failure. Until then
     nothing about the offer is known, so nothing about it is drawn. */
  const known = !accounts.isLoading && !mailboxes.isLoading;
  const local = localCalendarOffer(accounts.data);
  const reusable = mailboxes.data ?? [];
  const googleBuiltIn = accounts.data?.googleBuiltIn === true;
  /* With nothing else on offer the disclosure would be the entire dialog, so
     the form is simply the dialog. Decided only once `known`, so it cannot
     flash open and then collapse.

     A server that did not answer is not a server with nothing to offer, so a
     failed read never promotes the manual form: the retry below is the way
     out of that, not a four-field form nobody asked for. */
  const nothingElse =
    known && !accounts.isError && !local.offer && reusable.length === 0;
  const manualOpen = manual || nothingElse;

  const preset =
    CALDAV_PRESETS.find((entry) => entry.id === presetId) ?? CALDAV_PRESETS[0];
  /* Derived, never a required field: the address already says it. The typed
     name wins when there is one — see the Name field under More settings. */
  const alias =
    normalizeAlias(form.alias) ||
    (form.email.trim() ? aliasForEmail(form.email) : "");

  const busy =
    connectLocal.isPending ||
    connectMailbox.isPending ||
    create.isPending ||
    startGoogle.isPending;

  const reset = () => {
    setManual(false);
    setAdvanced(false);
    setGoogleForm(false);
    setPresetId("icloud");
    setForm(blankForm());
    setGoogle({ clientId: "", clientSecret: "" });
    setReveal(false);
    setValidation(null);
    setBlockedUrl(null);
    setConfirm(null);
    pinned.current = false;
    connectLocal.reset();
    connectMailbox.reset();
    create.reset();
    startGoogle.reset();
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const connected = (name: string) => {
    toast.success(`Connected ${name}`);
    close();
  };

  /**
   * Every one-click path runs through here, so the duplicate question is asked
   * the same way whichever row raised it: a 409 is the server saying "this looks
   * like a calendar you already have", which is a question, not a failure. The
   * retry is the identical call with the answer attached.
   */
  const runConnect = (
    start: (confirmOverlap: boolean) => void,
  ) => {
    setValidation(null);
    setConfirm(null);
    start(false);
  };

  const onConnectError = (
    error: unknown,
    retry: () => void,
  ): void => {
    if (!needsConfirmation(error)) return;
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
   * A preset writes the address and the help text, and nothing else. Every
   * field stays editable — a self-hosted iCloud-shaped setup is somebody's real
   * arrangement, and a locked box would be a dead end for them.
   */
  const choosePreset = (next: PresetId) => {
    pinned.current = true;
    setPresetId(next);
    setValidation(null);
    create.reset();
    const chosen = CALDAV_PRESETS.find((entry) => entry.id === next);
    if (!chosen) return;
    setForm((value) => ({ ...value, serverUrl: chosen.serverUrl }));
    // Nothing was filled in, so the field they now have to fill in must be on
    // screen rather than behind a disclosure they have not opened.
    if (!chosen.serverUrl) setAdvanced(true);
  };

  const onEmailChange = (value: string) => {
    setValidation(null);
    const type = pinned.current ? null : addressTells(value);
    if (type) setPresetId(type.id);
    setForm((current) => ({
      ...current,
      email: value,
      serverUrl: type ? type.serverUrl : current.serverUrl,
    }));
  };

  const requireBasics = (): boolean => {
    if (!form.email.trim()) {
      setValidation("Type the address you sign in to that calendar with.");
      emailRef.current?.focus();
      return false;
    }
    if (!form.password.trim()) {
      setValidation("An app password is needed.");
      passwordRef.current?.focus();
      return false;
    }
    if (!form.serverUrl.trim()) {
      setValidation(
        "This provider's CalDAV address is not one Boxaide knows. Paste it under More settings.",
      );
      setAdvanced(true);
      // After the panel exists, not before it.
      window.setTimeout(() => serverRef.current?.focus(), 0);
      return false;
    }
    setValidation(null);
    return true;
  };

  /**
   * One button, not Test then Add. The server tests the login before it stores
   * anything, so a press either connects the calendar or comes back with the
   * reason it could not — which is exactly what a separate Test told you, one
   * press later and with nothing saved either way.
   */
  const onAddCaldav = () => {
    if (!requireBasics()) return;
    create.mutate(
      {
        alias,
        serverUrl: form.serverUrl.trim(),
        username: form.email.trim(),
        password: stripPasswordSpaces(form.password),
      },
      { onSuccess: (account) => connected(account.alias) },
    );
  };

  const onStartGoogle = () => {
    // With the built-in client there is nothing to type: the server holds the
    // pair, and the callback names the account after the Google address.
    const body = googleBuiltIn
      ? {}
      : {
          clientId: google.clientId.trim(),
          clientSecret: google.clientSecret.trim(),
        };
    if (!googleBuiltIn && (!body.clientId || !body.clientSecret)) {
      setValidation("Both the client ID and the client secret are needed.");
      return;
    }
    setValidation(null);
    setBlockedUrl(null);
    startGoogle.mutate(body, {
      onSuccess: (result) => {
        // This runs after the mutation resolves, so it is no longer inside the
        // click that started it and a popup blocker will refuse it. Nothing is
        // claimed until a window actually exists: otherwise the dialog would
        // close on a tab that was never opened.
        const opened = window.open(result.authUrl, "_blank", "noopener,noreferrer");
        if (!opened) {
          setBlockedUrl(result.authUrl);
          return;
        }
        toast.success("Approve Boxaide in the new tab", {
          description:
            "The calendar shows up here once Google has sent you back.",
        });
        close();
      },
    });
  };

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
          // Enter belongs to whichever form the caret is in.
          if (event.target.id.startsWith("google-")) onStartGoogle();
          else onAddCaldav();
        }}
      >
        <DialogHeader>
          <DialogTitle className="title-15">Add a calendar</DialogTitle>
          <DialogDescription>
            Boxaide stores anything it needs encrypted on your own machine and
            never sends it anywhere else.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>

        {!known ? (
          <p className="flex items-center gap-2 py-2 text-[13px] leading-[18px] text-fg-tertiary">
            <Spinner />
            Checking what this machine can connect…
          </p>
        ) : (
          <div className="space-y-2">
            {accounts.isError && (
              <div className="space-y-2">
                <p className="text-[12px] leading-4 text-danger">
                  {`Boxaide could not ask your server which calendars it can offer: ${friendlyError(errorText(accounts.error))}`}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || accounts.isFetching}
                  onClick={() => void accounts.refetch()}
                >
                  {accounts.isFetching && <Spinner />}
                  Try again
                </Button>
              </div>
            )}

            {/* macOS refused once already. A button here could only fail, so
                the sentence that names the Settings pane stands on its own. */}
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
                onClick={() => runConnect(connectLocalNow)}
              />
            )}

            {reusable.map((mailbox) => (
              <OptionButton
                key={mailbox.mailAccountId}
                icon={<Mail className="size-4" strokeWidth={1.5} />}
                title={`Add your ${mailbox.provider} calendar`}
                detail={`Uses the password already stored for ${mailbox.email}. Nothing to type.`}
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
                onClick={() =>
                  runConnect((confirmOverlap) =>
                    connectMailboxNow(mailbox.mailAccountId, confirmOverlap),
                  )
                }
              />
            ))}

            {accounts.isError ? null : googleBuiltIn ? (
              <OptionButton
                icon={<ExternalLink className="size-4" strokeWidth={1.5} />}
                title="Continue with Google"
                detail="Opens Google's approval page in a new tab. Nothing to set up first."
                pending={startGoogle.isPending}
                pendingLabel="Opening Google…"
                disabled={busy}
                onClick={onStartGoogle}
              />
            ) : (
              /* No built-in client, so Google is the long way round: the person
                 has to create an OAuth client in their own Google Cloud project
                 first. Collapsed, because that is five steps and two secrets. */
              <Disclosure
                id="calendar-google"
                open={googleForm}
                label="Continue with Google"
                detail="Needs an OAuth client from your own Google Cloud project."
                onToggle={() => setGoogleForm((value) => !value)}
              >
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
                      setGoogle((v) => ({
                        ...v,
                        clientSecret: event.target.value,
                      }));
                    }}
                  />
                </Field>

                <Button
                  type="button"
                  disabled={busy}
                  aria-busy={startGoogle.isPending || undefined}
                  onClick={onStartGoogle}
                >
                  {startGoogle.isPending && <Spinner />}
                  {startGoogle.isPending
                    ? "Opening Google…"
                    : "Continue with Google"}
                </Button>
              </Disclosure>
            )}

            {/* The manual form. Last, and closed, unless it is the only way in
                — see nothingElse. */}
            {nothingElse ? (
              <div className="space-y-3 pt-1">{caldavForm()}</div>
            ) : (
              <Disclosure
                id="calendar-manual"
                open={manualOpen}
                label="Type in a calendar yourself"
                detail="For iCloud, Fastmail, Nextcloud and most other providers. You need your email address and an app password."
                onToggle={() => setManual((value) => !value)}
              >
                {caldavForm()}
              </Disclosure>
            )}
          </div>
        )}

        <div role="status" aria-live="polite" className="space-y-1.5">
          {blockedUrl && (
            <div className="space-y-2">
              <p className="text-[12px] leading-4 text-fg-secondary">
                Your browser blocked the new tab. Open Google&rsquo;s approval
                page yourself:
              </p>
              <Button asChild variant="secondary" size="sm">
                <a href={blockedUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink className="size-3.5" strokeWidth={1.5} />
                  Open Google&rsquo;s approval page
                </a>
              </Button>
              <CopyBlock value={blockedUrl} label="the approval link" />
            </div>
          )}

          {validation && (
            <p className="text-[12px] leading-4 text-danger">{validation}</p>
          )}

          {/* The server writes these sentences itself — which System Settings
              pane to open, which mailbox password was refused — so they are
              shown as written rather than through friendlyError, whose table
              would rewrite anything containing the word "password". */}
          {/* A duplicate is asked about, not reported: the sentence sits in the
              warning colour with the button that answers it, and the error line
              below is skipped so the same 409 is not also shown as a failure. */}
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

          {(create.error || startGoogle.error) && (
            <div>
              <p className="text-[12px] leading-4 text-danger">
                {friendlyError(errorText(create.error ?? startGoogle.error))}
              </p>
              <TechnicalDetails
                raw={errorText(create.error ?? startGoogle.error)}
              />
            </div>
          )}
        </div>

        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {manualOpen && (
            <Button
              type="button"
              disabled={busy}
              aria-busy={create.isPending || undefined}
              onClick={onAddCaldav}
            >
              {create.isPending && <Spinner />}
              {create.isPending ? "Checking the connection…" : "Add calendar"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  /**
   * Two fields and a button, the same shape as the mailbox dialog: the only two
   * answers a person actually holds are their address and their app password.
   * The name and the server address are derived from the address and stay
   * editable underneath, because a derived value that cannot be corrected is a
   * dead end for anyone self-hosting.
   */
  function caldavForm() {
    return (
      <>
        <Segmented
          label="Calendar provider"
          options={PRESET_OPTIONS}
          value={presetId}
          onChange={choosePreset}
        />

        <Field
          id="calendar-email"
          label="Email address"
          helper="The address you sign in to that calendar with."
        >
          <Input
            id="calendar-email"
            ref={emailRef}
            type="email"
            value={form.email}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder="you@example.com"
            onChange={(event) => onEmailChange(event.target.value)}
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
              ref={passwordRef}
              type={reveal ? "text" : "password"}
              value={form.password}
              autoComplete="off"
              className="pr-8"
              onChange={(event) => {
                setValidation(null);
                setForm((v) => ({ ...v, password: event.target.value }));
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
          aria-controls="calendar-advanced"
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
          <div id="calendar-advanced" className="space-y-3">
            <Field
              id="calendar-alias"
              label="Name"
              helper="Shown beside every event from this calendar."
            >
              <Input
                id="calendar-alias"
                value={form.alias}
                autoComplete="off"
                placeholder={alias || "Taken from the address"}
                onChange={(event) => {
                  setValidation(null);
                  setForm((v) => ({ ...v, alias: event.target.value }));
                }}
              />
            </Field>

            <Field
              id="calendar-server"
              label="Server URL"
              helper={
                preset.serverUrl
                  ? "Filled in from the address. Change it only if your provider gave you a different one."
                  : "The CalDAV address your provider gave you."
              }
            >
              <Input
                id="calendar-server"
                ref={serverRef}
                value={form.serverUrl}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder={preset.placeholder}
                onChange={(event) => {
                  setValidation(null);
                  setForm((v) => ({ ...v, serverUrl: event.target.value }));
                }}
              />
            </Field>
          </div>
        )}
      </>
    );
  }
}

/** A titled row that opens into a form. Same control as the mailbox dialog's
 *  "More settings", one size up because it carries a sentence too. */
function Disclosure({
  id,
  open,
  label,
  detail,
  onToggle,
  children,
}: {
  id: string;
  open: boolean;
  label: string;
  detail: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 rounded-[var(--radius-md)] p-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "mt-px size-4 shrink-0 text-fg-tertiary transition-transform duration-[var(--dur-fast)]",
            open && "rotate-90",
          )}
          strokeWidth={1.5}
        />
        <span className="min-w-0">
          <span className="block text-[13px] leading-[18px] font-medium text-fg">
            {label}
          </span>
          <span className="block text-[12px] leading-4 text-fg-tertiary">
            {detail}
          </span>
        </span>
      </button>
      {open && (
        <div id={id} className="space-y-3 px-3 pt-1 pb-1">
          {children}
        </div>
      )}
    </div>
  );
}

function blankForm() {
  return {
    email: "",
    password: "",
    alias: "",
    // Starts on the first preset's address rather than empty, so the form is
    // never a lie: a checked iCloud chip over an empty server field would be.
    serverUrl: CALDAV_PRESETS[0].serverUrl,
  };
}

/** The server normalises an alias exactly this way (mail service.ts:49). */
function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

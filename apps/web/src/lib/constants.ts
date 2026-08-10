/** Compile-time constants. Nothing here is a secret and nothing here fetches. */

/**
 * Pre-filled server URL on a browser with nothing in localStorage.
 * NEXT_PUBLIC_* is inlined into the bundle at build time and is public by
 * definition — it may never hold a token.
 */
export const DEFAULT_API_BASE =
  process.env.NEXT_PUBLIC_DEFAULT_API_BASE ?? "http://127.0.0.1:8787";

/** Mirrors MAX_LIMIT in src/api/routes.ts. The server 400s above this. */
export const MAX_LIMIT = 200;

/** The server's own default when `limit` is omitted. */
export const DEFAULT_LIMIT = 50;

/** How long a reachability probe waits before it is called unreachable (§7.2). */
export const HEALTH_TIMEOUT_MS = 8_000;

/** Search input debounce before a request is issued (§6.3). */
export const SEARCH_DEBOUNCE_MS = 300;

/** Most recent command-palette entries kept in localStorage (§2.6). */
export const MAX_RECENT_COMMANDS = 8;

/** Account rail hues. Index comes from hueIndex(); both themes define all 8. */
export const ACCOUNT_HUE_COUNT = 8;
export const ACCOUNT_HUES = [
  "var(--acct-0)",
  "var(--acct-1)",
  "var(--acct-2)",
  "var(--acct-3)",
  "var(--acct-4)",
  "var(--acct-5)",
  "var(--acct-6)",
  "var(--acct-7)",
] as const;

export type ProviderPreset = {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Shown under the chip row. Empty for "Other". */
  hint: string;
};

/**
 * Host/port defaults and app-password guidance, carried over verbatim from
 * web/app.js:389 so the two UIs cannot drift.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    hint: "Gmail needs a 16-character App password, not your Google password. Turn on 2-Step Verification first, then create one at myaccount.google.com/apppasswords.",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    hint: "Fastmail needs an app password: Settings → Privacy & Security → App passwords.",
  },
  {
    id: "outlook",
    label: "Outlook",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    hint: "Outlook needs an app password from account.microsoft.com → Security. Work or school accounts often block IMAP entirely.",
  },
  {
    id: "icloud",
    label: "iCloud",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    hint: "iCloud needs an app-specific password from account.apple.com → Sign-In and Security.",
  },
  {
    id: "other",
    label: "Other",
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
    hint: "",
  },
] as const;

/** Fallback IMAP port when the user leaves the field empty (§6.5). */
export const DEFAULT_IMAP_PORT = 993;
/** Fallback SMTP port when the user leaves the field empty (§6.5). */
export const DEFAULT_SMTP_PORT = 465;

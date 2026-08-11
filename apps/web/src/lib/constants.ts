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

export type ProviderPreset = {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** One-line version, shown under the chip row in the compact dialog. */
  hint: string;
  /**
   * The long version, for the first-run wizard: what the thing is called on
   * that provider's own website, and the exact clicks to reach it. Written for
   * someone who has never heard the phrase "app password".
   */
  passwordName: string;
  /**
   * Sits inside the empty password box, where someone about to type their
   * normal account password is actually looking. Empty for "Other", whose
   * password may well be the account one.
   */
  passwordPlaceholder: string;
  steps: readonly string[];
  /**
   * Where the steps end up. A full https URL, because both mailbox forms open
   * it in a new tab — a bare host would resolve against the app's own origin.
   */
  passwordUrl: string;
  /** Names the provider's own site on the button that opens passwordUrl. */
  passwordUrlLabel: string;
  /**
   * Addresses that pick this preset on their own, lowercase, no leading @.
   * Only the domains a provider actually hands out — a custom domain on Google
   * Workspace is unknowable from the address alone.
   */
  domains: readonly string[];
};

/**
 * Host/port defaults and app-password guidance, carried over from
 * web/app.js:389 so the two UIs cannot drift.
 *
 * Every provider here refuses a normal account password over IMAP. That is not
 * a mailmux rule and there is no way around it, so the wizard leads with it
 * rather than letting a login fail first.
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
    passwordName: "App password",
    passwordPlaceholder: "16-letter code, not your Gmail password",
    passwordUrl: "https://myaccount.google.com/apppasswords",
    passwordUrlLabel: "Open Google settings",
    domains: ["gmail.com", "googlemail.com"],
    steps: [
      "Open myaccount.google.com and pick Security in the left menu.",
      "Turn on 2-Step Verification if it is off. Google hides app passwords until you do.",
      "Go to myaccount.google.com/apppasswords. Search for “app passwords” in the same Security page if the link bounces you.",
      "Type mailmux as the name and press Create.",
      "Google shows 16 letters in four groups. Copy them — spaces do not matter — and paste them below. You will not see them again.",
    ],
  },
  {
    id: "outlook",
    label: "Outlook",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    hint: "Outlook needs an app password from account.microsoft.com → Security. Work or school accounts often block IMAP entirely.",
    passwordName: "App password",
    passwordPlaceholder: "App password, not your normal one",
    passwordUrl: "https://account.microsoft.com/security",
    passwordUrlLabel: "Open Microsoft settings",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    steps: [
      "Open account.microsoft.com and choose Security.",
      "Turn on two-step verification if it is off. App passwords only exist once it is on.",
      "Choose Advanced security options, then App passwords, then Create a new app password.",
      "Copy the password Microsoft shows and paste it below.",
      "A work or school address is different: many companies switch IMAP off entirely, and no password will get in. Ask whoever runs your email.",
    ],
  },
  {
    id: "icloud",
    label: "iCloud",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    hint: "iCloud needs an app-specific password from account.apple.com → Sign-In and Security.",
    passwordName: "App-specific password",
    passwordPlaceholder: "16-letter code from Apple",
    passwordUrl: "https://account.apple.com",
    passwordUrlLabel: "Open Apple settings",
    domains: ["icloud.com", "me.com", "mac.com"],
    steps: [
      "Open account.apple.com and sign in.",
      "Choose Sign-In and Security, then App-Specific Passwords.",
      "Press the plus button, type mailmux as the label, and confirm with your Apple Account password.",
      "Copy the password Apple shows — four groups of four letters — and paste it below.",
      "Use your full @icloud.com address as the email, even if you normally sign in with something else.",
    ],
  },
  {
    id: "fastmail",
    label: "Fastmail",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    hint: "Fastmail needs an app password: Settings → Privacy & Security → App passwords.",
    passwordName: "App password",
    passwordPlaceholder: "App password, not your normal one",
    passwordUrl: "https://app.fastmail.com/settings/security/apppasswords",
    passwordUrlLabel: "Open Fastmail settings",
    domains: ["fastmail.com", "fastmail.fm"],
    steps: [
      "Open Fastmail in a browser and go to Settings.",
      "Choose Privacy & Security, then App Passwords.",
      "Press New App Password, name it mailmux, and allow it Mail (IMAP/SMTP) access.",
      "Copy the password Fastmail shows and paste it below.",
    ],
  },
  {
    id: "other",
    label: "Other",
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
    hint: "",
    passwordName: "Password",
    passwordPlaceholder: "",
    passwordUrl: "",
    passwordUrlLabel: "",
    domains: [],
    steps: [
      "Find your provider's IMAP and SMTP settings — they are usually on a page called “IMAP settings” or “Mail client setup”.",
      "If your provider offers app passwords, make one for mailmux rather than using your account password.",
      "Fill in both host names below. Port 993 for IMAP and 465 or 587 for SMTP covers nearly everyone.",
    ],
  },
] as const;

/**
 * The preset a typed address gives away, or null when the domain is not one of
 * the four — an unknown domain leaves whatever is selected alone rather than
 * guessing "Other" over a choice someone already made.
 */
export function presetForEmail(email: string): ProviderPreset | null {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return null;
  return (
    PROVIDER_PRESETS.find((entry) => entry.domains.includes(domain)) ?? null
  );
}

/**
 * App passwords are shown in groups — Google's sixteen letters arrive as four
 * words — and every provider then rejects the spaces. Stripping them on submit
 * rather than on keystroke leaves the field editable as typed.
 */
export function stripPasswordSpaces(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * A Google app password is exactly sixteen letters, shown as four groups of
 * four. Nothing else on the preset row has a format this predictable, so this
 * is the one provider where a normal account password can be caught before it
 * is sent — every other provider gets no length rule at all.
 */
export function isGoogleAppPassword(value: string): boolean {
  return /^[a-z]{16}$/i.test(stripPasswordSpaces(value));
}

/** Shown by both mailbox forms when a Gmail submit carries something else. */
export const GMAIL_PASSWORD_PROBLEM =
  "That looks like your normal Google password. Gmail needs the 16-letter code — use the Open Google settings button above.";

/** Fallback IMAP port when the user leaves the field empty (§6.5). */
export const DEFAULT_IMAP_PORT = 993;
/** Fallback SMTP port when the user leaves the field empty (§6.5). */
export const DEFAULT_SMTP_PORT = 465;

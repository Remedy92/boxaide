/**
 * Which connected mailboxes already hold everything a CalDAV calendar needs.
 *
 * A mailbox and a calendar at the same provider are usually the same account
 * with the same app password, and the app already stores that password. So the
 * cheapest calendar to connect is one the user has already connected as mail:
 * nothing to type, nothing to look up in a settings page.
 *
 * The table is keyed on the IMAP host rather than on the address domain,
 * because the host is what the user (or the connect form's own derivation)
 * actually committed to, and a custom domain hosted at Fastmail carries no
 * hint in its address.
 *
 * Two absences are deliberate:
 * - Gmail. Google withdrew CalDAV access for app passwords, so a Gmail app
 *   password that reads mail perfectly will still fail against the calendar.
 *   Offering it would be offering a dead end; Google Calendar has its own
 *   OAuth path in this module.
 * - Outlook.com / Office 365. Microsoft has no CalDAV endpoint at all.
 */
export type CaldavForMailbox = {
  /** The CalDAV entry point a reused mailbox would be pointed at. */
  serverUrl: string;
  /** Human name of the provider, for the sentence the UI writes. */
  label: string;
};

const KNOWN: ReadonlyArray<{ hosts: readonly string[] } & CaldavForMailbox> = [
  {
    hosts: ["imap.mail.me.com"],
    serverUrl: "https://caldav.icloud.com",
    label: "iCloud",
  },
  {
    hosts: ["imap.fastmail.com"],
    serverUrl: "https://caldav.fastmail.com/dav/",
    label: "Fastmail",
  },
];

/**
 * The CalDAV server for a mailbox's IMAP host, or null when this provider has
 * no CalDAV endpoint we can name without asking. Null is the honest answer for
 * everything else: guessing `caldav.<domain>` would produce an account that
 * fails its connection test for a reason the user cannot act on.
 */
export function caldavForMailbox(imapHost: string): CaldavForMailbox | null {
  const host = imapHost.trim().toLowerCase();
  for (const entry of KNOWN) {
    if (entry.hosts.includes(host)) {
      return { serverUrl: entry.serverUrl, label: entry.label };
    }
  }
  return null;
}

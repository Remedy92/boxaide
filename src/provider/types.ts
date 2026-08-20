/**
 * How the mailbox authenticates. Password is today's path (app passwords).
 * XOAUTH2 is prep for Microsoft/Google OAuth — not wired from the UI yet.
 */
export type MailAuth =
  | { kind: "password"; user: string; pass: string }
  | { kind: "xoauth2"; user: string; accessToken: string };

export type AccountCredentials = {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  auth: MailAuth;
};

/** Login user from either auth kind. */
export function authUser(creds: AccountCredentials): string {
  return creds.auth.user;
}

/** Build password-auth credentials (REST connect form, fixtures, tests). */
export function passwordCredentials(
  base: Omit<AccountCredentials, "auth"> & { user: string; pass: string },
): AccountCredentials {
  const { user, pass, ...hosts } = base;
  return { ...hosts, auth: { kind: "password", user, pass } };
}

/**
 * Identity + credentials handed to every provider call.
 * Providers need the account's own address (From headers, fixture fabrication),
 * which `creds.auth.user` does not reliably carry.
 */
export type ProviderAccount = {
  id: string;
  alias: string;
  email: string;
  creds: AccountCredentials;
};

export type MailAccountMeta = {
  id: string;
  alias: string;
  email: string;
  createdAt: string;
};

export type MailMessageSummary = {
  id: string;
  accountId: string;
  uid: number;
  messageId?: string;
  folder: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  /**
   * Server receive time, when the read asked for it. The `date` above comes
   * from the sender's header and a wrong clock on their side would hide a
   * message that really did arrive inside a `since` window.
   */
  internalDate?: string;
  snippet: string;
  seen: boolean;
  hasAttachments: boolean;
};

export type MailMessage = MailMessageSummary & {
  bodyText: string;
  bodyHtml?: string;
  cc?: string;
  bcc?: string;
  /** Space-separated References chain, for replying in-thread. */
  references?: string;
  /**
   * Inbound iMIP part (RFC 6047) — the invite or reply .ics that came with the
   * mail. Optional because it only exists when the sender attached one, and
   * because the fixture provider and index-served rows never carry it: the
   * summary row this type extends comes from the SQLite index, which stores
   * headers only. Reach for it after a real getMessage, not off a list.
   */
  calendar?: { method?: string; content: string };
};

/**
 * ISO timestamp. IMAP SINCE compares whole days, so the server hands back the
 * whole day and the provider trims the remainder against the exact instant.
 * Without it a caller asking for "the last 24 hours" gets the newest `limit`
 * messages instead, which silently drops mail after a busy period.
 */
export type SinceOpt = { since?: string };

export type ListMessagesOpts = SinceOpt & {
  folder?: string;
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  /** Blocking IMAP fill even when the index is warm. CRM sync uses this. */
  refresh?: boolean;
};

export type SearchMessagesOpts = SinceOpt & {
  query: string;
  folder?: string;
  limit?: number;
};

export type SendMessageInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  /**
   * iMIP calendar part (RFC 6047). Nodemailer emits it as text/calendar with
   * the method parameter, which is what makes Gmail/Outlook render the
   * Accept/Decline bar instead of a dead .ics attachment.
   */
  icalEvent?: { method: "REQUEST" | "CANCEL"; content: string };
};

export type SendResult = {
  messageId: string;
  accepted: string[];
  /** Sent-folder copy, when APPEND (or the fixture) named the new uid. */
  copied?: MailMessageSummary;
  /**
   * Where the copy landed. Servers name that mailbox differently — "Sent",
   * "Sent Items", "[Gmail]/Sent Mail" — so callers must not guess it.
   */
  sentFolder?: string;
};

export type ConnectionTestResult = {
  ok: boolean;
  error?: string;
};

/**
 * Where a moved message came from and where it landed.
 *
 * `moved: false` means the uid was no longer in the source folder — another
 * client got there first — and nothing was written. Callers must not report
 * an archive that did not happen.
 */
export type MoveResult = {
  moved: boolean;
  /** Mailbox it came from. An undo moves it back here. */
  fromFolder: string;
  /** Mailbox it landed in. */
  toFolder: string;
  /**
   * The message's new `accountId:folder:uid` id. Only a server with UIDPLUS
   * names the new uid, so without it the mail is still in `toFolder` — there
   * is just no id to address it by, and an undo has nothing to move back.
   */
  id?: string;
};

/**
 * Fields of a draft. Every one is optional on purpose: a draft is allowed to
 * be half-written, which is the whole reason it is not a SendMessageInput.
 */
export type DraftInput = {
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
};

/** Where a draft landed. `id` is the same accountId:folder:uid shape as mail. */
export type DraftRef = {
  id: string;
  accountId: string;
  uid: number;
  folder: string;
  messageId: string;
};

export type MailDraft = DraftRef & {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  date: string;
  snippet: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string;
};

export type ListDraftsOpts = {
  limit?: number;
};

/** IMAP resync cursor stored in mailbox_state. */
export type MailboxCursor = {
  uidvalidity: number;
  highestModseq: string | null;
  uidnext: number | null;
  exists: number;
};

export type SyncMailboxOpts = SinceOpt & {
  folder?: string;
  limit?: number;
  offset?: number;
  cursor?: MailboxCursor | null;
  /** Ignore CHANGEDSINCE and refill the sequence window of `limit`. */
  fullWindow?: boolean;
  /** Indexed UIDs; used to detect expunges when VANISHED is missing. */
  knownUids?: number[];
};

export type MailboxSyncResult = {
  /** True when the indexed window was replaced (cold fill or uidvalidity). */
  replaced: boolean;
  messages: MailMessageSummary[];
  vanishedUids: number[];
  flagUpdates: Array<{ uid: number; seen: boolean }>;
  cursor: MailboxCursor;
  /**
   * Set when the read was `since`-driven: every message at or after this
   * instant is now in `messages`, so the index can answer that window without
   * asking IMAP again.
   */
  coveredSince?: string;
};

export type MailFolder = {
  name: string;
  path: string;
  specialUse?: string;
};

/** Provider contract — IMAP and fixture both implement this. */
export interface MailProvider {
  /** Runs before an account exists, so it takes bare credentials. */
  testConnection(creds: AccountCredentials): Promise<ConnectionTestResult>;
  listMessages(
    account: ProviderAccount,
    opts?: ListMessagesOpts,
  ): Promise<MailMessageSummary[]>;
  /**
   * Fill or incrementally update a folder window. `replaced` means the caller
   * should drop cached rows for that folder before upserting.
   */
  syncMailbox(
    account: ProviderAccount,
    opts?: SyncMailboxOpts,
  ): Promise<MailboxSyncResult>;
  /**
   * Keep the connection selected on `folder` and invoke `onChange` on EXISTS /
   * FLAGS / EXPUNGE. Returns an unsubscribe. Optional: fixture has nothing to
   * watch.
   */
  watchMailbox?(
    account: ProviderAccount,
    folder: string,
    onChange: () => void,
  ): () => void;
  searchMessages(
    account: ProviderAccount,
    opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]>;
  getMessage(
    account: ProviderAccount,
    messageId: string,
    folder?: string,
  ): Promise<MailMessage | null>;
  sendMessage(
    account: ProviderAccount,
    input: SendMessageInput,
  ): Promise<SendResult>;
  /**
   * Move one message into another mailbox. Throws when the id cannot be parsed
   * or the message already sits in `folder`; returns `moved: false` when the
   * uid is no longer in the source folder.
   */
  moveMessage(
    account: ProviderAccount,
    messageId: string,
    folder: string,
  ): Promise<MoveResult>;
  /**
   * Move one message into the account's Archive mailbox. Which mailbox that is
   * is the provider's to resolve, because servers name it differently, and a
   * server with no Archive mailbox at all throws rather than guessing one:
   * filing mail somewhere the user's own client will never look for it is
   * worse than not filing it.
   */
  archiveMessage(
    account: ProviderAccount,
    messageId: string,
  ): Promise<MoveResult>;
  /** Set or clear the \Seen flag. Returns false when the message is gone. */
  markRead(
    account: ProviderAccount,
    messageId: string,
    seen: boolean,
  ): Promise<boolean>;
  listFolders(account: ProviderAccount): Promise<MailFolder[]>;
  /**
   * Store a new draft in the account's Drafts mailbox. Nothing leaves the
   * machine: this is the write path that does not deliver mail.
   */
  createDraft(
    account: ProviderAccount,
    input: DraftInput,
  ): Promise<DraftRef>;
  /**
   * Replace a draft's content. A draft is immutable on IMAP, so this stores a
   * new one and removes the old — the returned ref carries a NEW id, and the
   * id passed in is dead afterwards.
   */
  updateDraft(
    account: ProviderAccount,
    draftId: string,
    input: DraftInput,
  ): Promise<DraftRef>;
  listDrafts(
    account: ProviderAccount,
    opts?: ListDraftsOpts,
  ): Promise<MailDraft[]>;
  /** Returns false when the draft is already gone. */
  deleteDraft(account: ProviderAccount, draftId: string): Promise<boolean>;
}

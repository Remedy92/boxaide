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
};

export type SendResult = {
  messageId: string;
  accepted: string[];
};

export type ConnectionTestResult = {
  ok: boolean;
  error?: string;
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

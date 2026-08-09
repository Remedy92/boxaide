export type AccountCredentials = {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
};

/**
 * Identity + credentials handed to every provider call.
 * Providers need the account's own address (From headers, fixture fabrication),
 * which `creds.username` does not reliably carry.
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

export type ListMessagesOpts = {
  folder?: string;
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
};

export type SearchMessagesOpts = {
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
}

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

/** Provider contract — IMAP and fixture both implement this. */
export interface MailProvider {
  testConnection(creds: AccountCredentials): Promise<ConnectionTestResult>;
  listMessages(
    accountId: string,
    creds: AccountCredentials,
    opts?: ListMessagesOpts,
  ): Promise<MailMessageSummary[]>;
  searchMessages(
    accountId: string,
    creds: AccountCredentials,
    opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]>;
  getMessage(
    accountId: string,
    creds: AccountCredentials,
    messageId: string,
    folder?: string,
  ): Promise<MailMessage | null>;
  sendMessage(
    accountId: string,
    creds: AccountCredentials,
    input: SendMessageInput,
  ): Promise<SendResult>;
}

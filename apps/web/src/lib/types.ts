/**
 * Exact mirrors of the Sley backend JSON.
 *
 * Every type here is field-for-field from src/provider/types.ts and the
 * responses in src/api/routes.ts. Optionality is load-bearing: `messageId`,
 * `bodyHtml`, `cc`, `bcc`, `references` and `specialUse` are genuinely
 * optional and the UI must handle their absence.
 */

/** GET /api/accounts → { accounts: MailAccountMeta[] } */
export type MailAccountMeta = {
  id: string; // 16 hex chars
  alias: string; // normalised: trim → lowercase → whitespace to "-"
  email: string;
  createdAt: string; // ISO 8601
};

/**
 * POST /api/accounts 201 → { account: CreatedAccount }.
 * NOT MailAccountMeta — createdAt is absent. Never type this as MailAccountMeta.
 */
export type CreatedAccount = { id: string; alias: string; email: string };

/** Rows from GET /api/messages and GET /api/messages/search. */
export type MailMessageSummary = {
  id: string; // `${accountId}:${encodeURIComponent(folder)}:${uid}` — MUST be encodeURIComponent'd in a path
  accountId: string; // the account id, never the alias
  uid: number;
  messageId?: string; // RFC Message-ID. Absent ⇒ replying in-thread is impossible.
  folder: string;
  from: string; // preformatted "Name <a@b.c>" or comma-joined. Can be "".
  to: string; // same. Can be "".
  subject: string; // falls back to the literal "(no subject)". Never "".
  date: string; // ISO 8601. Falls back to send-time "now" when the envelope has none.
  snippet: string; // ≤140 chars. May equal `subject`. Can be "".
  seen: boolean;
  hasAttachments: boolean; // boolean only — no count, no names, no sizes, no download
};

/** GET /api/messages/:accountId/:messageId → { message: MailMessage } */
export type MailMessage = MailMessageSummary & {
  bodyText: string; // always present, may be "", truncated at 50 000 chars
  bodyHtml?: string; // RAW UNSANITISED SENDER HTML. NEVER RENDER. NEVER dangerouslySetInnerHTML.
  cc?: string;
  bcc?: string; // declared but never populated on the read path — always undefined in practice
  references?: string; // space-separated Message-ID chain
};

/** GET /api/folders?account=<id> → { folders: MailFolder[] }. 400s on account=all. */
export type MailFolder = {
  name: string;
  path: string; // the value to pass as ?folder=
  specialUse?: string; // e.g. "\\Sent". Absent on servers without SPECIAL-USE.
}; // NO message count. NO unread count.

/** Present on EVERY list/search 200 response, `[]` when nothing failed. */
export type AccountError = { account: string; error: string }; // `account` is the ALIAS

export type MessageListResponse = {
  messages: MailMessageSummary[];
  errors: AccountError[];
};

/** POST /api/messages/send 201 → { result: SendResult } */
export type SendResult = { messageId: string; accepted: string[] }; // messageId may be ""

/* -------------------------------------------------------------------------- */
/* drafts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Body of POST /api/drafts and POST /api/drafts/:accountId/:draftId.
 *
 * Every field is optional because a draft is allowed to be half-written — that
 * is the whole reason it is not a SendMessageBody. The update route REPLACES
 * the draft, so anything omitted is dropped rather than merged.
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

/**
 * What create and update return. It carries no content: a draft is stored by
 * APPEND, so the server answers with where it landed and nothing else. Refetch
 * the list to read a draft back.
 */
export type DraftRef = {
  id: string; // `${accountId}:${encodeURIComponent(folder)}:${uid}`, same shape as a message id
  accountId: string;
  uid: number;
  folder: string;
  messageId: string;
};

/** A row from GET /api/drafts?account=… — full body text included. */
export type MailDraft = DraftRef & {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  date: string; // ISO 8601
  snippet: string;
  bodyText: string;
  bodyHtml?: string; // RAW UNSANITISED HTML. NEVER RENDER.
  inReplyTo?: string;
  references?: string;
};

/** POST /api/accounts/test → 200 {ok:true} | 400 {ok:false, error} */
export type ConnectionTestResult = { ok: boolean; error?: string };

/** GET /api/meta */
export type MetaResponse = { tokenHint: string; mcpPath: string; auth: string };

/** GET /health — unauthenticated */
export type HealthResponse = { ok: true; service: "sley"; fixture: boolean };

/** GET /api/health — authenticated */
export type ApiHealthResponse = { ok: true; service: "sley"; version: string };

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

/* -------------------------------------------------------------------------- */
/* the agent conversation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One turn. `activity` is the agent narrating what it is doing rather than
 * answering, and the UI draws it as a quiet line instead of a message.
 */
export type AgentTurn = {
  seq: number;
  at: string; // ISO 8601
  role: "user" | "agent" | "activity";
  text: string;
  /** MCP client name. Best effort — see AgentChannel.noteClient on the server. */
  agent: string | null;
  /**
   * User turns: an agent has taken this one and no agent will be given it
   * again. Absent on a server built before the field existed, and false on the
   * live stream frame, which is written before the hand-off — the client also
   * remembers what it saw claimed. See useAgent().claimed.
   */
  delivered?: boolean;
  /**
   * User seq this turn answers. Absent on a server built before the field
   * existed; null on user rows and unstamped agent/activity.
   */
  replyTo?: number | null;
};

/**
 * Who is listening, and who Sley spawned.
 *
 * `waiting` is the only field that is proof of a parked chat_await_message.
 * `listening` also accepts an agent that called within the last few seconds,
 * so a normal poll loop does not flicker. `launchedAgent` is the CLI this
 * process started (sidebar Start). Neither is a claim that a client is
 * "connected" — see the capabilities dialog.
 */
export type AgentPresence = {
  waiting: number;
  listening: boolean;
  lastSeenAt: string | null;
  lastAgent: string | null;
  /** Registry id of the CLI Sley spawned. Null when nothing is launched. */
  launchedAgent: string | null;
  /**
   * A message an agent took and has not answered yet — see AgentChannel.Work.
   * Null whenever nothing is in flight, and on a server built before this
   * field existed, which is why every reader treats absence as "not working".
   */
  working: AgentWork | null;
};

/** The one thing Sley can prove about an agent's own work. */
export type AgentWork = {
  /** The `seq` of the user turn being answered. */
  seq: number;
  since: string; // ISO 8601
  agent: string | null;
  /** The last mail tool called since the hand-off. */
  tool: { name: string; at: string } | null;
};

/** GET /api/agent/state */
export type AgentStateResponse = {
  turns: AgentTurn[];
  presence: AgentPresence;
};

/** Union of every error body shape the server can emit. */
export type ErrorBody =
  | { error: string }
  | { deleted: false } // DELETE /api/accounts/:id 404 has NO `error` key
  | { ok: false; error: string };

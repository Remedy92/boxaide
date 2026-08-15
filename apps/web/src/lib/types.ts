/**
 * Exact mirrors of the Boxaide backend JSON.
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
export type HealthResponse = { ok: true; service: "boxaide"; fixture: boolean };

/** GET /api/health — authenticated */
export type ApiHealthResponse = { ok: true; service: "boxaide"; version: string };

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
   * User turns: an agent is holding this one, already answered it, or held it
   * until it was dead-lettered. A live hold is a lease, not a permanent take —
   * a vanished holder gives the row back. Absent on a server built before the
   * field existed, and false on the live stream frame, which is written before
   * the hand-off. See useAgent().claimed.
   */
  delivered?: boolean;
  /**
   * User seq this turn answers. Absent on a server built before the field
   * existed; null on user rows and unstamped agent/activity.
   */
  replyTo?: number | null;
};

/**
 * Who is listening, and who Boxaide spawned.
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
  /** Registry id of the CLI Boxaide spawned. Null when nothing is launched. */
  launchedAgent: string | null;
  /**
   * A message an agent took and has not answered yet — see AgentChannel.Work.
   * Null whenever nothing is in flight, and on a server built before this
   * field existed, which is why every reader treats absence as "not working".
   */
  working: AgentWork | null;
  /**
   * User seqs leased until the delivery cap and never answered. The pane
   * warning is these. Absent on a server built before the field existed.
   */
  dropped?: number[];
};

/** The one thing Boxaide can prove about an agent's own work. */
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

/* -------------------------------------------------------------------------- */
/* CRM — contacts, orgs, notes, interactions, pipeline                        */
/* -------------------------------------------------------------------------- */

/**
 * Field-for-field from src/crm/store.ts. Two things are load-bearing here.
 *
 * Identity fields (email, name, org name/domain) arrive in plaintext — the spec
 * keeps them out of the encrypted set because UNIQUE and search need them.
 * Mail-derived text (note bodies, interaction subjects and snippets) is stored
 * encrypted and decrypted by the store on the way out, so what lands here is
 * already readable and must never be persisted by this client.
 */
export type CrmOrganization = {
  id: string;
  name: string;
  domain: string | null;
  createdAt: string;
};

/** Rows from GET /api/crm/contacts. `orgName` is joined, not stored. */
export type CrmContact = {
  id: string;
  email: string; // lowercase
  name: string | null;
  title: string | null;
  orgId: string | null;
  orgName: string | null;
  source: string; // 'mail' | 'agent' | 'manual'
  createdAt: string;
  updatedAt: string;
};

export type CrmNote = {
  id: string;
  contactId: string;
  at: string;
  text: string; // decrypted server-side
};

export type CrmInteraction = {
  id: string;
  contactId: string;
  accountId: string;
  messageId: string; // accountId:folder:uid — NOT fetchable without the folder
  direction: "in" | "out";
  at: string;
  subject: string | null; // decrypted server-side
  snippet: string | null; // decrypted server-side
};

export type CrmPipelineStage = { id: string; name: string; position: number };

export type CrmDeal = {
  id: string;
  title: string;
  contactId: string | null;
  orgId: string | null;
  stageId: string;
  value: number | null;
  currency: string | null;
  position: number; // order within the stage
  createdAt: string;
  updatedAt: string;
};

/**
 * GET /api/crm/contacts/:id. The ONLY response in the CRM surface that is not
 * wrapped in a named key — routes.ts returns the detail object itself.
 */
export type CrmContactDetail = {
  contact: CrmContact;
  tags: string[];
  notes: CrmNote[];
  interactions: CrmInteraction[];
  deals: CrmDeal[];
};

/** GET /api/crm/pipeline → { stages: CrmPipelineBoard }. Stages in board order. */
export type CrmPipelineBoard = Array<CrmPipelineStage & { deals: CrmDeal[] }>;

/** POST /api/crm/sync — counts touched, not counts held. */
export type CrmSyncResult = { contacts: number; interactions: number };

/* -------------------------------------------------------------------------- */
/* automations — /api/automations/*                                           */
/* -------------------------------------------------------------------------- */

/**
 * Field-for-field from src/automation/store.ts.
 *
 * `prompt` is user-authored instructions to a future agent run and is stored in
 * plaintext by design; run logs are NOT — they quote mail, so they are
 * encrypted at rest and arrive here already decrypted and tail-trimmed.
 */
export type Automation = {
  id: string;
  name: string;
  /** 5-field cron. The server rejects anything else, including the 6-field form. */
  cron: string;
  prompt: string;
  /** Launcher AgentSpec id. Null ⇒ the first available agent runs it. */
  agentId: string | null;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  /** Null while disabled or unschedulable — never a claim that a run is due. */
  nextRunAt: string | null;
};

export type AutomationRunStatus = "running" | "ok" | "error" | "killed";

export type AutomationRun = {
  id: string;
  automationId: string;
  startedAt: string;
  /** Null while the run is still going. */
  finishedAt: string | null;
  status: AutomationRunStatus;
  exitCode: number | null;
  /** Decrypted server-side, LAST 4 KiB only. "" when nothing was captured. */
  log: string;
};

/* -------------------------------------------------------------------------- */
/* outreach — /api/outreach/*                                                 */
/* -------------------------------------------------------------------------- */

export type CampaignStatus = "draft" | "active" | "paused" | "done";

/**
 * A campaign row from GET /api/outreach/campaigns. `counts` is keyed by
 * campaign-contact state ('active' | 'replied' | 'opted_out' | 'done' |
 * 'suppressed') and OMITS states with no rows — never read it as a full map.
 *
 * The sequence steps are not on this response. No GET returns them: they are
 * authored through the agent, and PATCH echoes them back.
 */
export type OutreachCampaign = {
  id: string;
  name: string;
  accountId: string;
  status: CampaignStatus;
  createdAt: string;
  counts: Record<string, number>;
};

export type OutboxStatus =
  | "pending"
  | "approved"
  | "sent"
  | "rejected"
  | "failed";

/**
 * One queued outreach email. `subject` and `body` are stored encrypted and
 * arrive decrypted — mail content, rendered as TEXT and never as HTML, and
 * never persisted by this client.
 *
 * There is no route that edits a row: the queue offers approve and reject, and
 * "edit" means the human takes the text into the composer and sends it
 * themselves.
 */
export type OutboxRow = {
  id: string;
  accountId: string;
  campaignId: string | null;
  contactId: string | null;
  stepPosition: number | null;
  to: string;
  subject: string;
  body: string;
  status: OutboxStatus;
  createdAt: string;
  decidedAt: string | null;
  sentAt: string | null;
  error: string | null;
};

export type SuppressionRow = {
  email: string; // lowercase
  reason: string; // 'reply-stop' | 'manual' | 'bounce' | 'agent'
  at: string;
};

/** GET /api/outreach/badge — a COUNT of pending rows and nothing else. */
export type OutreachBadge = { pending: number };

/**
 * GET /api/update — the whole updater state, in one object.
 *
 * Every command returns this same shape, so the rail never derives a state of
 * its own. `channel` decides what the card can offer: "auto" is the desktop
 * app, which installs; "manual" is a self-hosted server, which can only say
 * that a newer version exists and link to it.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type UpdateState = {
  channel: "auto" | "manual";
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  /** 0–1 while downloading, null otherwise. */
  progress: number | null;
  checkedAt: string | null;
  error: string | null;
  canInstall: boolean;
};

/** Union of every error body shape the server can emit. */
export type ErrorBody =
  | { error: string }
  | { deleted: false } // DELETE /api/accounts/:id 404 has NO `error` key
  | { ok: false; error: string };

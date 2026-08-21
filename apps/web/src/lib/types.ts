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
  bodyHtml?: string; // RAW UNSANITISED SENDER HTML. Hostile input. Render ONLY via <HtmlBody> (DOMPurify + sandboxed frame). NEVER dangerouslySetInnerHTML. Why: SECURITY.md, "HTML mail rendering" (§6.4.6).
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

/**
 * POST /api/messages/:accountId/:messageId/archive → this, 200.
 * Also the body of POST …/move. 404 means the message had already left
 * `fromFolder` — another client moved it first and nothing was written.
 */
export type MoveResult = {
  moved: boolean;
  fromFolder: string; // where it came from — an undo moves it back here
  toFolder: string; // where it landed
  id?: string; // its new id. ABSENT on a server without UIDPLUS, so no undo.
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
  /**
   * The chat this turn belongs to. Absent on a server built before chats
   * existed, where every turn was the one conversation.
   */
  chatId?: string;
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
  /** The chat that question was asked in. Absent on an older server. */
  chatId?: string;
  since: string; // ISO 8601
  agent: string | null;
  /** The last mail tool called since the hand-off. */
  tool: { name: string; at: string } | null;
};

/**
 * One conversation.
 *
 * `archivedAt` is set on a chat whose messages were dropped to keep the store
 * inside its budget. The row survives so the list does not silently lose
 * entries; the messages do not.
 */
export type AgentChat = {
  id: string;
  title: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  archivedAt: string | null;
  /** True once this chat has lost old turns to its own limit. */
  trimmed: boolean;
  /** The chat the composer writes to. Exactly one is active. */
  active: boolean;
  turns: number;
  bytes: number;
};

/** What the storage line reads from. Bytes of conversation text, not disk. */
export type AgentChatStorage = {
  bytes: number;
  budget: number;
  chats: number;
  archived: number;
};

/** GET /api/agent/chats */
export type AgentChatsResponse = {
  chats: AgentChat[];
  storage: AgentChatStorage;
};

/** GET /api/agent/state */
export type AgentStateResponse = {
  turns: AgentTurn[];
  presence: AgentPresence;
  /** The chat those turns came from. Absent on an older server. */
  chat?: AgentChat;
  /**
   * Actions waiting on the user. Absent on a server built before agents could
   * ask, which every reader treats as none.
   */
  approvals?: import("@/lib/api/endpoints").AgentApproval[];
  /**
   * What launched agents archived, newest run first. Absent on a server built
   * before the log existed, which every reader treats as none.
   */
  archiveSweeps?: import("@/lib/api/endpoints").AgentArchiveSweep[];
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
  /** Model id for that agent's CLI. Null ⇒ the CLI's own default. */
  model: string | null;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  /** Null while disabled or unschedulable — never a claim that a run is due. */
  nextRunAt: string | null;
  /** The newest run's status; null before the first run. */
  lastRunStatus: AutomationRunStatus | null;
};

export type AutomationRunStatus = "running" | "ok" | "error" | "killed";

/**
 * GET /api/automations/badge — runs that finished since the Automations view
 * was last open, and how many of those failed. Two COUNTs and nothing else.
 */
export type AutomationBadge = { unseen: number; failed: number };

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
  contactId: string | null;
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
 * Which capability a connector's key switches on: finding new prospects,
 * looking up an email address, or searching the web.
 */
export type ConnectorKind = "prospecting" | "enrichment" | "search";

/**
 * GET /api/connectors, and the body of PUT /api/connectors/:id.
 *
 * The server never returns a full key. `maskedKey` is the last four characters
 * of whichever source won, and `source` says which one that was: a key saved
 * here beats one in the server's environment, and clearing the saved key falls
 * back to the environment rather than to nothing.
 */
export type Connector = {
  id: string;
  label: string;
  kind: ConnectorKind;
  configured: boolean;
  source: "settings" | "env" | null;
  maskedKey: string | null;
};

/**
 * What the provider said when Boxaide last asked it about the key.
 *
 * Three answers, and the third is the one that stops a lie: "unreachable" is
 * the vendor being down or slow, which says nothing at all about the key.
 * `maskedKey` names the key the answer was about, so a verdict is dropped the
 * moment the key it judged is replaced.
 */
export type ConnectorCheckVerdict = "works" | "rejected" | "unreachable";

export type ConnectorCheck = {
  verdict: ConnectorCheckVerdict;
  reason: string | null;
  checkedAt: string;
  maskedKey: string;
};

/** GET /api/connectors: every connector, plus the verdicts still in force. */
export type ConnectorsSnapshot = {
  connectors: Connector[];
  checks: Record<string, ConnectorCheck>;
};

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

/* -------------------------------------------------------------------------- */
/* calendar — /api/calendar/*                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Three providers, and they are not symmetrical. A CalDAV account is a URL, a
 * username and an app password, so the UI can create one outright. Google is an
 * OAuth handshake the server finishes after the browser has left for Google, so
 * the UI can only start it — see startGoogleCalendarAuth. `local` is the
 * calendars macOS already holds: there are no credentials at all, only a system
 * permission the user grants once.
 */
export type CalendarProvider = "caldav" | "google" | "local";

export type CalendarAccount = {
  id: string;
  alias: string;
  provider: CalendarProvider;
  /** Empty for `local`: that account is every account macOS holds. */
  email: string;
  createdAt: string;
};

/** What macOS reports about the local path, probed without prompting anyone. */
export type LocalCalendarStatus = {
  available: boolean;
  /**
   * Why the local path cannot be used, written for a person to read. Set when
   * `available` is false, and also when the helper answers perfectly and macOS
   * is simply refusing — a denial no click can clear, only System Settings.
   */
  reason?: string;
  access?: "notDetermined" | "restricted" | "denied" | "fullAccess" | "writeOnly" | "authorized";
};

/**
 * GET /api/calendar/accounts.
 *
 * `googleRedirectUri` is the URI the SERVER hands Google, built from the
 * address it bound to. It is here because only the server knows it: the page
 * can be served from another origin entirely, and Google rejects the sign-in
 * unless the registered URI matches that string character for character.
 *
 * `local` and `googleBuiltIn` are the same kind of fact: which ways in this
 * machine and this build can offer. Neither is derivable from anything the page
 * can see, and both decide what the Add-calendar dialog puts first.
 *
 * All three are optional: a server built before them simply omits them, and the
 * UI falls back to the paths that have always existed.
 */
export type CalendarAccountsResponse = {
  accounts: CalendarAccount[];
  googleRedirectUri?: string;
  googleBuiltIn?: boolean;
  local?: LocalCalendarStatus;
};

/**
 * A mailbox whose stored password would also open a calendar. GET
 * /api/calendar/mailboxes. No secret is in here — the password stays server
 * side, which is the whole point of connecting by id.
 */
export type ReusableMailbox = {
  mailAccountId: string;
  email: string;
  /** The calendar provider's name, for the button: "iCloud", "Fastmail". */
  provider: string;
  serverUrl: string;
  suggestedAlias: string;
  /**
   * Set to the name macOS shows for an account that looks like this same
   * calendar, when the Mac's calendars are connected. Present means connecting
   * this would probably duplicate an agenda, not that it is forbidden — the
   * server asks for confirmation rather than refusing.
   */
  onThisMac?: string;
};

export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled";

/**
 * One event as the agenda returns it. `start` and `end` are instants; the local
 * time a person reads is this browser's, not the calendar server's.
 */
export type CalendarEvent = {
  id: string;
  accountId: string;
  accountAlias: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  status: CalendarEventStatus;
  busy: boolean;
};

/**
 * `errors` is per calendar account: one unreachable server does not empty the
 * agenda, it appears beside the events that did load. Same contract as the
 * message list's partial-failure array.
 */
export type AgendaResponse = { events: CalendarEvent[]; errors: string[] };

/**
 * GET /api/calendar/free-slots — windows nothing is booked over.
 *
 * A suggestion, not a hold: nothing is reserved, and the same slot can be
 * offered to two people. `errors` follows the agenda's rule — a calendar that
 * did not answer is named rather than silently treated as empty, which would
 * suggest times that are in fact taken.
 */
export type FreeSlot = { start: string; end: string };

/**
 * `timeZone` is the zone the working hours were read in — the one this app
 * asked for, or the server's own when it asked for none. Always echoed, so the
 * suggestion strip can name the clock it is quoting rather than assume it.
 */
export type FreeSlotsResponse = {
  slots: FreeSlot[];
  errors: string[];
  timeZone: string;
};

export type MeetingStatus = "scheduled" | "cancelled";

/**
 * How one invited guest answered.
 *
 * "needs-action" is the resting state, not a failure: it is every guest the
 * moment the invitation goes out. The server merges two sources — a guest's
 * reply email wins where there is one, the calendar's own attendee list fills
 * in the rest — and `source` says which one this entry came from.
 */
export type RsvpStatus = "accepted" | "declined" | "tentative" | "needs-action";

export type AttendeeResponse = {
  email: string;
  status: RsvpStatus;
  respondedAt: string | null;
  source: string;
};

/** A meeting BOXAIDE created — not every event on the calendar. */
export type Meeting = {
  id: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location: string | null;
  meetingUrl: string | null;
  status: MeetingStatus;
  createdAt: string;
  /** One entry per invited guest, in `attendees` order. Never partial. */
  attendeeStatus: AttendeeResponse[];
};

/**
 * `refreshError` is the last background reply-scan's failure, or null. The
 * meetings themselves come from the server's own store and are never held up
 * by that scan, so a failure here means the responses may be behind — not that
 * the list is wrong.
 */
export type MeetingsResponse = {
  meetings: Meeting[];
  refreshError: string | null;
};

/** What one explicit "check for replies" pass did. */
export type RsvpRefreshResult = { updated: number; errors: string[] };

/**
 * Creating or cancelling a meeting touches a calendar AND sends invitations, so
 * a 200 can still carry partial failure: `warnings` is what did not happen.
 */
export type MeetingResult = { meeting: Meeting; warnings: string[] };

/**
 * Creating adds `timeZone`: the zone the invitation text was written in.
 * Cancelling writes no times into an email, so it echoes none.
 */
export type CreateMeetingResult = MeetingResult & { timeZone: string };

/** Union of every error body shape the server can emit. */
export type ErrorBody =
  | { error: string }
  | { deleted: false } // DELETE /api/accounts/:id 404 has NO `error` key
  | { ok: false; error: string };

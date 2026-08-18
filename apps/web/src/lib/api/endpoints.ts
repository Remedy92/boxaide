/**
 * One typed function per endpoint the app is allowed to touch. Nothing outside
 * this file may call `request`, and nothing anywhere may call `fetch`.
 *
 * Never called from this app:
 *   GET /api/agent-connect  — its response embeds the full bearer token; the
 *     MCP snippet is built client-side from localStorage instead (§6.7).
 *
 * Called only with a desktop-shell capability:
 *   GET /api/local-bootstrap — exchanges a one-time fragment secret for the
 *     persistent token. Same-origin loopback alone is intentionally not enough.
 */

import { query, request, stream } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { DEFAULT_LIMIT } from "@/lib/constants";
import type {
  AccountCredentials,
  AgendaResponse,
  AgentPresence,
  AgentChat,
  AgentChatsResponse,
  AgentStateResponse,
  AgentTurn,
  ApiHealthResponse,
  Automation,
  AutomationRun,
  CalendarAccount,
  CalendarAccountsResponse,
  ConnectionTestResult,
  CreatedAccount,
  CrmContact,
  CrmContactDetail,
  CrmDeal,
  CrmInteraction,
  CrmNote,
  CrmOrganization,
  CrmPipelineBoard,
  CreateMeetingResult,
  CrmSyncResult,
  DraftInput,
  DraftRef,
  FreeSlotsResponse,
  HealthResponse,
  MailDraft,
  MailFolder,
  MailMessage,
  MailAccountMeta,
  MeetingResult,
  MeetingsResponse,
  MessageListResponse,
  MetaResponse,
  OutboxRow,
  OutboxStatus,
  OutreachBadge,
  OutreachCampaign,
  CampaignStatus,
  ReusableMailbox,
  RsvpRefreshResult,
  SendResult,
  SuppressionRow,
  UpdateState,
} from "@/lib/types";

/** Everything an endpoint needs: which server, which token, how to cancel. */
export type Ctx = {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
};

/* -------------------------------------------------------------------------- */
/* health and metadata                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Unauthenticated. Sends no Authorization header, so it triggers no preflight —
 * that is what lets the UI tell "server unreachable" apart from "bad token".
 */
export function getHealth(ctx: Ctx): Promise<HealthResponse> {
  return request<HealthResponse>("/health", {
    baseUrl: ctx.baseUrl,
    token: "",
    signal: ctx.signal,
  });
}

/** Authenticated. A 401 here means the token is wrong, not that the box is down. */
export function getApiHealth(ctx: Ctx): Promise<ApiHealthResponse> {
  return request<ApiHealthResponse>("/api/health", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
    transport: { healthReachable: true },
  });
}

export type LocalBootstrapResponse = {
  token: string;
  fixture: boolean;
  mcpUrl: string;
};

/**
 * The token, in plaintext. The server answers only on loopback when the caller
 * presents the desktop shell's one-time capability. Anywhere else, a human
 * pastes the token.
 */
export function getLocalBootstrap(
  ctx: Ctx,
  capability: string,
): Promise<LocalBootstrapResponse> {
  return request<LocalBootstrapResponse>("/api/local-bootstrap", {
    baseUrl: ctx.baseUrl,
    token: "",
    signal: ctx.signal,
    headers: { "X-Boxaide-Bootstrap": capability },
  });
}

/** `tokenHint` is the first 4 characters plus an ellipsis — safe to display. */
export function getMeta(ctx: Ctx): Promise<MetaResponse> {
  return request<MetaResponse>("/api/meta", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/* -------------------------------------------------------------------------- */
/* accounts                                                                   */
/* -------------------------------------------------------------------------- */

export async function listAccounts(ctx: Ctx): Promise<MailAccountMeta[]> {
  const data = await request<{ accounts: MailAccountMeta[] }>("/api/accounts", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.accounts;
}

export type CreateAccountBody = {
  alias: string;
  email: string;
  imapHost: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username: string;
  password: string;
};

/**
 * Performs a live IMAP login server-side, so it can take several seconds.
 * Re-POSTing an existing alias UPDATES that mailbox instead of creating a
 * second one. The 201 body is {id, alias, email} with no createdAt — refetch
 * listAccounts() for the full record.
 */
export async function createAccount(
  body: CreateAccountBody,
  ctx: Ctx,
): Promise<CreatedAccount> {
  const data = await request<{ account: CreatedAccount }>("/api/accounts", {
    method: "POST",
    body,
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.account;
}

/**
 * All 8 credential fields are required — the server applies no defaults on this
 * route. A failed test is an HTTP 400 whose body is still {ok:false, error}, so
 * the body is read before the failure is rethrown.
 */
export async function testCredentials(
  creds: AccountCredentials,
  ctx: Ctx,
): Promise<ConnectionTestResult> {
  try {
    return await request<ConnectionTestResult>("/api/accounts/test", {
      method: "POST",
      body: creds,
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const parsed = parseJson(err.raw);
      if (parsed && typeof parsed === "object" && "ok" in parsed) {
        return parsed as ConnectionTestResult;
      }
    }
    throw err;
  }
}

/**
 * Accepts an id or an alias. The 404 body is {deleted:false} with no `error`
 * key, so it is normalised here rather than surfacing as a bare ApiError.
 */
export async function deleteAccount(
  idOrAlias: string,
  ctx: Ctx,
): Promise<{ deleted: boolean }> {
  try {
    return await request<{ deleted: boolean }>(
      `/api/accounts/${encodeURIComponent(idOrAlias)}`,
      {
        method: "DELETE",
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        signal: ctx.signal,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { deleted: false };
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* messages                                                                   */
/* -------------------------------------------------------------------------- */

export type ListMessagesQuery = {
  /** Account id or alias, or "all". Defaults to "all". */
  account?: string;
  /** 1–200. Defaults to 50. */
  limit?: number;
  folder?: string;
  unreadOnly?: boolean;
};

/** `unread` is only ever the literal "1" — `unread=true` is silently ignored. */
export function listMessages(
  o: ListMessagesQuery,
  ctx: Ctx,
): Promise<MessageListResponse> {
  const qs = query({
    account: o.account ?? "all",
    limit: o.limit ?? DEFAULT_LIMIT,
    folder: o.folder,
    unread: o.unreadOnly ? "1" : undefined,
  });
  return request<MessageListResponse>(`/api/messages${qs}`, {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

export type SearchMessagesQuery = {
  q: string;
  account?: string;
  limit?: number;
};

/**
 * `folder` is accepted by the URL and ignored by the server (routes.ts:197
 * never forwards it), so it is deliberately not part of this signature: search
 * always runs against Inbox.
 */
export function searchMessages(
  o: SearchMessagesQuery,
  ctx: Ctx,
): Promise<MessageListResponse> {
  const qs = query({
    account: o.account ?? "all",
    q: o.q,
    limit: o.limit ?? DEFAULT_LIMIT,
  });
  return request<MessageListResponse>(`/api/messages/search${qs}`, {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/**
 * The composite message id contains colons and an already-encoded folder, so it
 * must be encodeURIComponent'd again before it goes into the path.
 */
export async function getMessage(
  accountId: string,
  messageId: string,
  ctx: Ctx,
): Promise<MailMessage> {
  const data = await request<{ message: MailMessage }>(
    `/api/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(messageId)}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.message;
}

/** `seen` must be a real boolean; anything else is a 400. */
export function markRead(
  accountId: string,
  messageId: string,
  seen: boolean,
  ctx: Ctx,
): Promise<{ updated: boolean; seen: boolean }> {
  return request<{ updated: boolean; seen: boolean }>(
    `/api/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(messageId)}/read`,
    {
      method: "POST",
      body: { seen },
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
}

export type SendMessageBody = {
  /** Account id or alias. `from` is forced server-side to that account's address. */
  account: string;
  to: string;
  subject: string;
  text: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
};

export async function sendMessage(
  body: SendMessageBody,
  ctx: Ctx,
): Promise<SendResult> {
  const data = await request<{ result: SendResult }>("/api/messages/send", {
    method: "POST",
    body,
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.result;
}

/* -------------------------------------------------------------------------- */
/* drafts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/drafts?account=… — ONE mailbox at a time.
 *
 * `account=all` is a 400, and there is no unified draft endpoint, so the
 * unified Drafts view fans out one request per mailbox client-side and merges
 * the answers (see useDrafts).
 */
export async function listDrafts(
  accountRef: string,
  ctx: Ctx,
  limit?: number,
): Promise<MailDraft[]> {
  const data = await request<{ drafts: MailDraft[] }>(
    `/api/drafts${query({ account: accountRef, limit: limit ?? DEFAULT_LIMIT })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.drafts;
}

/**
 * The 201 body is a DraftRef: where it landed, with no content. Refetch the
 * list to read the draft back.
 */
export async function createDraft(
  accountRef: string,
  input: DraftInput,
  ctx: Ctx,
): Promise<DraftRef> {
  const data = await request<{ draft: DraftRef }>("/api/drafts", {
    method: "POST",
    body: { account: accountRef, ...input },
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.draft;
}

/**
 * POST, not PUT — the server's CORS method list is deliberately short and an
 * update is a replace-and-delete, not an idempotent write.
 *
 * It REPLACES the draft, so every field to be kept must be sent, and it returns
 * a NEW id: the old one stops resolving. Callers must adopt `draft.id` from the
 * response or their next save 404s.
 */
export async function updateDraft(
  accountId: string,
  draftId: string,
  input: DraftInput,
  ctx: Ctx,
): Promise<DraftRef> {
  const data = await request<{ draft: DraftRef }>(
    `/api/drafts/${encodeURIComponent(accountId)}/${encodeURIComponent(draftId)}`,
    {
      method: "POST",
      body: input,
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.draft;
}

/** A 404 means the draft was already gone; that is normalised, not thrown. */
export async function deleteDraft(
  accountId: string,
  draftId: string,
  ctx: Ctx,
): Promise<{ deleted: boolean }> {
  try {
    return await request<{ deleted: boolean }>(
      `/api/drafts/${encodeURIComponent(accountId)}/${encodeURIComponent(draftId)}`,
      {
        method: "DELETE",
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        signal: ctx.signal,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { deleted: false };
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* folders                                                                    */
/* -------------------------------------------------------------------------- */

/** 400s on "all" or an empty value — folders are per mailbox. */
export async function listFolders(
  accountRef: string,
  ctx: Ctx,
): Promise<MailFolder[]> {
  const data = await request<{ folders: MailFolder[] }>(
    `/api/folders${query({ account: accountRef })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.folders;
}

/* -------------------------------------------------------------------------- */
/* the agent conversation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * History plus presence. `after` asks for turns newer than a sequence number,
 * `chat` for a conversation other than the active one.
 */
export function getAgentState(
  ctx: Ctx,
  after?: number,
  chat?: string,
): Promise<AgentStateResponse> {
  return request<AgentStateResponse>(`/api/agent/state${query({ after, chat })}`, {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/* ---- chats ----------------------------------------------------------------
   Whole list, no paging. One small row per conversation, and the rail's search
   box would otherwise need a round trip per keystroke.
   ------------------------------------------------------------------------ */

export function listAgentChats(
  ctx: Ctx,
  includeArchived = false,
): Promise<AgentChatsResponse> {
  return request<AgentChatsResponse>(
    `/api/agent/chats${query({ archived: includeArchived ? 1 : undefined })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
}

export function createAgentChat(ctx: Ctx): Promise<{ chat: AgentChat }> {
  return request<{ chat: AgentChat }>("/api/agent/chats", {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

export function selectAgentChat(id: string, ctx: Ctx): Promise<{ chat: AgentChat }> {
  return request<{ chat: AgentChat }>(
    `/api/agent/chats/${encodeURIComponent(id)}/select`,
    { method: "POST", baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
}

export function renameAgentChat(
  id: string,
  title: string,
  ctx: Ctx,
): Promise<{ renamed: boolean }> {
  return request<{ renamed: boolean }>(`/api/agent/chats/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { title },
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

export function archiveAgentChat(id: string, ctx: Ctx): Promise<{ archived: boolean }> {
  return request<{ archived: boolean }>(
    `/api/agent/chats/${encodeURIComponent(id)}/archive`,
    { method: "POST", baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
}

export function deleteAgentChat(id: string, ctx: Ctx): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/agent/chats/${encodeURIComponent(id)}`, {
    method: "DELETE",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/**
 * Post the user's message.
 *
 * The response carries presence as it was at the moment of the write, which is
 * what lets the composer say "no agent is listening" about THIS message rather
 * than about whatever the last stream frame happened to report.
 *
 * `chat` names the conversation the pane is showing. Without it the server
 * writes to whatever chat is active, which is one row shared by every window.
 */
export function sendAgentMessage(
  text: string,
  ctx: Ctx,
  chat?: string,
): Promise<{ turn: AgentTurn; presence: AgentPresence }> {
  return request<{ turn: AgentTurn; presence: AgentPresence }>("/api/agent/messages", {
    method: "POST",
    body: chat ? { text, chat } : { text },
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/** Same `chat` rule as sendAgentMessage: clear the pane's chat, not the active one. */
export function clearAgentConversation(
  ctx: Ctx,
  chat?: string,
): Promise<{ cleared: boolean }> {
  return request<{ cleared: boolean }>("/api/agent/clear", {
    method: "POST",
    body: chat ? { chat } : undefined,
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/**
 * An action an agent asked for and nobody has answered yet.
 *
 * Mirrors ApprovalView in src/agent/approvals.ts. The text is built on the
 * server from the arguments that will actually be replayed, so what the card
 * shows and what happens on Approve cannot drift apart.
 */
export type AgentApproval = {
  id: string;
  /** message_send, meeting_create or meeting_cancel. */
  tool: string;
  /** One line: what happens if the user says yes. */
  title: string;
  fields: { label: string; value: string }[];
  /** The message or the meeting description. Null when the action has none. */
  body: string | null;
  /** Which launch asked: chat, driven, or run for a scheduled automation. */
  profile: string;
  agent: string | null;
  chatId: string | null;
  askedAt: string;
};

export function decideAgentApproval(
  id: string,
  decision: "approve" | "deny",
  ctx: Ctx,
): Promise<{ state: string; outcome: string; pending: AgentApproval[] }> {
  return request(`/api/agent/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
    body: { decision },
  });
}

/**
 * Follow the conversation. Resolves when the server closes the stream; the
 * caller reconnects.
 */
export function streamAgent(
  ctx: Ctx,
  on: {
    turn: (turn: AgentTurn) => void;
    presence: (presence: AgentPresence) => void;
    chats?: (chats: AgentChatsResponse) => void;
    approvals?: (pending: AgentApproval[]) => void;
  },
): Promise<void> {
  return stream("/api/agent/stream", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
    onEvent: (event, data) => {
      try {
        if (event === "turn") on.turn(JSON.parse(data) as AgentTurn);
        else if (event === "presence") on.presence(JSON.parse(data) as AgentPresence);
        else if (event === "chats") on.chats?.(JSON.parse(data) as AgentChatsResponse);
        else if (event === "approvals") {
          on.approvals?.(JSON.parse(data) as AgentApproval[]);
        }
      } catch {
        // A frame we cannot parse is dropped rather than tearing down a live
        // conversation. The next one re-states presence anyway.
      }
    },
  });
}

/* -------------------------------------------------------------------------- */
/* CRM — /api/crm/*                                                           */
/* -------------------------------------------------------------------------- */

export type CrmContactsQuery = {
  /** Free text over name, email and org name. */
  query?: string;
  tag?: string;
  /** 1–200. Anything outside that range is a 400, not a clamp. */
  limit?: number;
};

export async function listCrmContacts(
  o: CrmContactsQuery,
  ctx: Ctx,
): Promise<CrmContact[]> {
  const data = await request<{ contacts: CrmContact[] }>(
    `/api/crm/contacts${query({
      query: o.query,
      tag: o.tag,
      limit: o.limit ?? DEFAULT_LIMIT,
    })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.contacts;
}

export type CrmContactBody = {
  email: string;
  name?: string;
  title?: string;
  /** Org NAME. The server resolves or creates it; `orgDomain` only helps match. */
  org?: string;
  orgDomain?: string;
  /**
   * ADDITIVE. `store.addTags` is INSERT OR IGNORE and the REST surface exposes
   * no removal, so sending a shorter list does not untag anything.
   */
  tags?: string[];
  source?: string;
};

/**
 * Upsert by lowercase email — re-POSTing an address EDITS that contact rather
 * than creating a second one, which is what makes this both "create" and
 * "edit". The route passes `force: true`, so an explicit name always wins over
 * the longest-name-seen rule that mail-derived rows follow.
 */
export async function upsertCrmContact(
  body: CrmContactBody,
  ctx: Ctx,
): Promise<CrmContact> {
  const data = await request<{ contact: CrmContact }>("/api/crm/contacts", {
    method: "POST",
    body,
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.contact;
}

/** The detail body is NOT wrapped in a key — see CrmContactDetail. */
export function getCrmContact(
  contactId: string,
  ctx: Ctx,
  limit?: number,
): Promise<CrmContactDetail> {
  return request<CrmContactDetail>(
    `/api/crm/contacts/${encodeURIComponent(contactId)}${query({ limit })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
}

/** A 404 means it was already gone; normalised rather than thrown. */
export async function deleteCrmContact(
  contactId: string,
  ctx: Ctx,
): Promise<{ deleted: boolean }> {
  try {
    return await request<{ deleted: boolean }>(
      `/api/crm/contacts/${encodeURIComponent(contactId)}`,
      {
        method: "DELETE",
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        signal: ctx.signal,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { deleted: false };
    throw err;
  }
}

export async function addCrmNote(
  contactId: string,
  text: string,
  ctx: Ctx,
): Promise<CrmNote> {
  const data = await request<{ note: CrmNote }>(
    `/api/crm/contacts/${encodeURIComponent(contactId)}/notes`,
    {
      method: "POST",
      body: { text },
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.note;
}

export async function listCrmInteractions(
  contactId: string,
  ctx: Ctx,
  limit?: number,
): Promise<CrmInteraction[]> {
  const data = await request<{ interactions: CrmInteraction[] }>(
    `/api/crm/contacts/${encodeURIComponent(contactId)}/interactions${query({
      limit,
    })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.interactions;
}

export async function listCrmOrgs(ctx: Ctx): Promise<CrmOrganization[]> {
  const data = await request<{ orgs: CrmOrganization[] }>("/api/crm/orgs", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.orgs;
}

export async function createCrmOrg(
  body: { name: string; domain?: string | null },
  ctx: Ctx,
): Promise<CrmOrganization> {
  const data = await request<{ org: CrmOrganization }>("/api/crm/orgs", {
    method: "POST",
    body,
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.org;
}

export async function getCrmPipeline(ctx: Ctx): Promise<CrmPipelineBoard> {
  const data = await request<{ stages: CrmPipelineBoard }>("/api/crm/pipeline", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.stages;
}

export type CrmDealBody = {
  /** Present ⇒ patch. Absent ⇒ create. An unknown id is a 404, never a create. */
  dealId?: string;
  title?: string;
  contactId?: string | null;
  orgId?: string | null;
  stageId?: string;
  value?: number | null;
  currency?: string | null;
};

export async function upsertCrmDeal(
  body: CrmDealBody,
  ctx: Ctx,
): Promise<CrmDeal> {
  const data = await request<{ deal: CrmDeal }>("/api/crm/deals", {
    method: "POST",
    body,
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.deal;
}

/** `position` is the index within the target stage; omitted means append. */
export async function moveCrmDeal(
  dealId: string,
  stageId: string,
  ctx: Ctx,
  position?: number,
): Promise<CrmDeal> {
  const data = await request<{ deal: CrmDeal }>(
    `/api/crm/deals/${encodeURIComponent(dealId)}/move`,
    {
      method: "POST",
      body: position === undefined ? { stageId } : { stageId, position },
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.deal;
}

export async function deleteCrmDeal(
  dealId: string,
  ctx: Ctx,
): Promise<{ deleted: boolean }> {
  try {
    return await request<{ deleted: boolean }>(
      `/api/crm/deals/${encodeURIComponent(dealId)}`,
      {
        method: "DELETE",
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        signal: ctx.signal,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { deleted: false };
    throw err;
  }
}

/**
 * Walks INBOX and Sent per mailbox server-side, so it can take seconds. The
 * counts are rows touched by THIS run, not the size of the CRM.
 */
export function syncCrm(ctx: Ctx): Promise<CrmSyncResult> {
  return request<CrmSyncResult>("/api/crm/sync", {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/* -------------------------------------------------------------------------- */
/* automations — /api/automations/*                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately absent from this file: POST /api/automations and
 * DELETE /api/automations/:id. Automations are written by talking to the agent
 * (spec: Web UI) — the UI has no create form, so it gets no create call.
 */
export async function listAutomations(ctx: Ctx): Promise<Automation[]> {
  const data = await request<{ automations: Automation[] }>("/api/automations", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
  return data.automations;
}

/**
 * PATCH — a partial write. The UI sends only how a run happens (`enabled`,
 * `agentId`, `model`); what it does — name, cron, prompt — is the agent's to
 * author. A bad cron or a duplicate name is a 400, not a 500.
 */
export async function updateAutomation(
  automationId: string,
  // agentId and model take null to mean "back to the default", so an absent
  // key and an explicit null are different requests — never collapse them.
  patch: {
    enabled?: boolean;
    name?: string;
    cron?: string;
    prompt?: string;
    agentId?: string | null;
    model?: string | null;
  },
  ctx: Ctx,
): Promise<Automation> {
  const data = await request<{ automation: Automation }>(
    `/api/automations/${encodeURIComponent(automationId)}`,
    {
      method: "PATCH",
      body: patch,
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.automation;
}

/**
 * 202 {queued:true} — the run is enqueued, NOT finished. Runs are serialized
 * one at a time server-side, so this can sit behind another agent for minutes.
 * Read the outcome back from the run list.
 */
export function runAutomationNow(
  automationId: string,
  ctx: Ctx,
): Promise<{ queued: boolean }> {
  return request<{ queued: boolean }>(
    `/api/automations/${encodeURIComponent(automationId)}/run`,
    {
      method: "POST",
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
}

/** `limit` defaults to 20 server-side; each run carries the last 4 KiB of log. */
export async function listAutomationRuns(
  automationId: string,
  ctx: Ctx,
  limit?: number,
): Promise<AutomationRun[]> {
  const data = await request<{ runs: AutomationRun[] }>(
    `/api/automations/${encodeURIComponent(automationId)}/runs${query({ limit })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.runs;
}

/* -------------------------------------------------------------------------- */
/* outreach — /api/outreach/*                                                 */
/* -------------------------------------------------------------------------- */

export async function listCampaigns(ctx: Ctx): Promise<OutreachCampaign[]> {
  const data = await request<{ campaigns: OutreachCampaign[] }>(
    "/api/outreach/campaigns",
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.campaigns;
}

/**
 * Status only, from this app: steps may be replaced while a campaign is a
 * draft, but they are the agent's to author and no GET returns them, so the UI
 * has nothing to send back. Activating a campaign kicks the engine server-side,
 * which queues step 0 — as pending outbox rows, never as sent mail.
 */
export async function updateCampaignStatus(
  campaignId: string,
  status: CampaignStatus,
  ctx: Ctx,
): Promise<OutreachCampaign> {
  const data = await request<{ campaign: OutreachCampaign }>(
    `/api/outreach/campaigns/${encodeURIComponent(campaignId)}`,
    {
      method: "PATCH",
      body: { status },
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.campaign;
}

export async function listOutbox(
  o: { status?: OutboxStatus; limit?: number },
  ctx: Ctx,
): Promise<OutboxRow[]> {
  const data = await request<{ outbox: OutboxRow[] }>(
    `/api/outreach/outbox${query({ status: o.status, limit: o.limit })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.outbox;
}

/**
 * The human decision, and the only one there is: no MCP tool approves, rejects
 * or sends an outbox row (spec invariant 1). Approving hands the row to the
 * engine, which sends it under the per-account daily cap and the 60s gap — so a
 * 200 here means "approved", never "delivered".
 *
 * Only a `pending` row can be decided; anything else is a 400 from the server.
 */
export async function decideOutbox(
  outboxId: string,
  decision: "approve" | "reject",
  ctx: Ctx,
): Promise<OutboxRow> {
  const data = await request<{ outbox: OutboxRow }>(
    `/api/outreach/outbox/${encodeURIComponent(outboxId)}/${decision}`,
    {
      method: "POST",
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.outbox;
}

export async function listSuppression(ctx: Ctx): Promise<SuppressionRow[]> {
  const data = await request<{ suppression: SuppressionRow[] }>(
    "/api/outreach/suppression",
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.suppression;
}

/** Suppression is enforced inside MailService.sendMessage, not by this UI. */
export async function addSuppression(
  email: string,
  reason: string,
  ctx: Ctx,
): Promise<SuppressionRow> {
  const data = await request<{ suppressed: SuppressionRow }>(
    "/api/outreach/suppression",
    {
      method: "POST",
      body: { email, reason },
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.suppressed;
}

/** A 404 means the address was not on the list; normalised rather than thrown. */
export async function removeSuppression(
  email: string,
  ctx: Ctx,
): Promise<{ deleted: boolean }> {
  try {
    return await request<{ deleted: boolean }>(
      `/api/outreach/suppression/${encodeURIComponent(email)}`,
      {
        method: "DELETE",
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        signal: ctx.signal,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { deleted: false };
    throw err;
  }
}

/** One COUNT. Polled every 30s by the rail badge; it must stay this cheap. */
export function getOutreachBadge(ctx: Ctx): Promise<OutreachBadge> {
  return request<OutreachBadge>("/api/outreach/badge", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/* -------------------------------------------------------------------------- */
/* calendar — /api/calendar/*                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The whole body, not just `accounts`: it also carries `googleRedirectUri`,
 * the URI this server hands Google. Only the server knows it — it is built from
 * the address the server bound to, which this page cannot see — and Google
 * rejects the sign-in unless the registered value matches it exactly.
 */
export function listCalendarAccounts(ctx: Ctx): Promise<CalendarAccountsResponse> {
  return request<CalendarAccountsResponse>("/api/calendar/accounts", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/** CalDAV only. Google is an OAuth handshake — see startGoogleCalendarAuth. */
export type CalDavAccountBody = {
  alias: string;
  serverUrl: string;
  username: string;
  password: string;
};

export async function createCalDavAccount(
  body: CalDavAccountBody,
  ctx: Ctx,
): Promise<CalendarAccount> {
  const data = await request<{ account: CalendarAccount }>(
    "/api/calendar/accounts",
    {
      method: "POST",
      body,
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.account;
}

/**
 * A live CalDAV login, server-side, so it can take seconds. A failed test may
 * come back as a 400 whose body is still {ok:false, error} — the same shape as
 * /api/accounts/test — so the body is read before the failure is rethrown.
 */
export async function testCalDavAccount(
  body: CalDavAccountBody,
  ctx: Ctx,
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await request<{ ok: boolean; error?: string }>(
      "/api/calendar/accounts/test",
      {
        method: "POST",
        body,
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        signal: ctx.signal,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const parsed = parseJson(err.raw);
      if (parsed && typeof parsed === "object" && "ok" in parsed) {
        return parsed as { ok: boolean; error?: string };
      }
    }
    throw err;
  }
}

/** A 404 means it was already gone; normalised rather than thrown. */
export async function deleteCalendarAccount(
  accountId: string,
  ctx: Ctx,
): Promise<{ deleted: boolean }> {
  try {
    return await request<{ deleted: boolean }>(
      `/api/calendar/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "DELETE",
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        signal: ctx.signal,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { deleted: false };
    throw err;
  }
}

/**
 * Mailboxes whose stored password would also open a calendar. Read-only and
 * cheap — the server makes no network call to answer — so it is safe beside the
 * account list on every page load.
 */
export async function listReusableMailboxes(ctx: Ctx): Promise<ReusableMailbox[]> {
  const data = await request<{ mailboxes: ReusableMailbox[] }>(
    "/api/calendar/mailboxes",
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
  return data.mailboxes;
}

/**
 * Connect one of them. The mailbox is named in the path and the password never
 * crosses the wire in either direction — the server already holds it.
 */
export async function connectMailboxCalendar(
  mailAccountId: string,
  ctx: Ctx,
  /**
   * Set only after the person has read the duplicate warning the server sent
   * back as a 409 and chosen to go ahead. Sending it unasked would silence the
   * one question worth asking.
   */
  confirmOverlap = false,
): Promise<CalendarAccount> {
  const data = await request<{ account: CalendarAccount }>(
    `/api/calendar/mailboxes/${encodeURIComponent(mailAccountId)}`,
    {
      method: "POST",
      body: confirmOverlap ? { confirmOverlap: true } : {},
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.account;
}

/**
 * Connect the calendars macOS already holds. There is nothing to send: the
 * whole handshake is the system permission dialog, which this call raises and
 * then waits on for as long as the person looks at it.
 */
export async function connectLocalCalendar(
  ctx: Ctx,
  /** Same rule as connectMailboxCalendar: only after the 409 was shown. */
  confirmOverlap = false,
): Promise<CalendarAccount> {
  const data = await request<{ account: CalendarAccount }>(
    "/api/calendar/local",
    {
      method: "POST",
      body: confirmOverlap ? { confirmOverlap: true } : {},
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
  return data.account;
}

/**
 * `clientId` and `clientSecret` are omitted when the server ships its own
 * Google client — see `googleBuiltIn` on the accounts response. `alias` may be
 * empty too: the callback falls back to the Google address it learns.
 */
export type GoogleCalendarStartBody = {
  alias?: string;
  clientId?: string;
  clientSecret?: string;
};

/**
 * Starts the handshake and returns nothing but a URL to send the person to.
 * Google redirects back to the SERVER, which finishes the setup — this page is
 * never told; it finds out by refetching the account list.
 */
export function startGoogleCalendarAuth(
  body: GoogleCalendarStartBody,
  ctx: Ctx,
): Promise<{ authUrl: string }> {
  return request<{ authUrl: string }>("/api/calendar/google/start", {
    method: "POST",
    body,
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/**
 * The merged agenda across every calendar account. `start` and `end` are ISO
 * instants, and one failing account is an entry in `errors`, not an empty list.
 */
export function getAgenda(
  window: { start: string; end: string },
  ctx: Ctx,
): Promise<AgendaResponse> {
  return request<AgendaResponse>(
    `/api/calendar/agenda${query({ start: window.start, end: window.end })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
}

/**
 * Times nothing is booked over, for the meeting form's suggestions.
 *
 * Advisory only: nothing is held, so a slot can go stale between being offered
 * and being used. A calendar that failed to answer appears in `errors` — its
 * busy time is missing, so the suggestions may cover it.
 */
export function getFreeSlots(
  o: {
    durationMinutes: number;
    start: string;
    end: string;
    maxSlots?: number;
    /* The working day is read as a wall clock in this zone. Sent from the
       browser so suggestions follow the viewer's own clock; omitted, the
       server falls back to its own, which is rarely the same one. */
    timeZone?: string;
  },
  ctx: Ctx,
): Promise<FreeSlotsResponse> {
  return request<FreeSlotsResponse>(
    `/api/calendar/free-slots${query({
      durationMinutes: o.durationMinutes,
      start: o.start,
      end: o.end,
      maxSlots: o.maxSlots,
      timeZone: o.timeZone,
    })}`,
    { baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
  );
}

/**
 * Meetings BOXAIDE created — not everything on the calendar.
 *
 * The whole body, not just `meetings`: `refreshError` tells the view whether
 * the guest responses beside each meeting are current.
 */
export function listMeetings(ctx: Ctx): Promise<MeetingsResponse> {
  return request<MeetingsResponse>("/api/calendar/meetings", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/**
 * Reads guest replies now, rather than waiting for the background scan.
 *
 * One pass over every meeting, not one meeting — the mailboxes and calendars
 * are scanned together — so the count comes back for the whole list. A
 * mailbox that could not be read is a string in `errors`, never a failure.
 */
export function refreshMeetingResponses(ctx: Ctx): Promise<RsvpRefreshResult> {
  return request<RsvpRefreshResult>("/api/calendar/meetings/refresh-rsvps", {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

export type CreateMeetingBody = {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  description?: string;
  location?: string;
  calendarAccountId?: string;
  mailAccountId?: string;
  includeMeetingLink?: boolean;
  /* The zone the invitation text is written in — the times the guest reads.
     The event itself is the absolute instants in `start` and `end`, so this
     changes the wording, never when the meeting happens. */
  timeZone?: string;
};

/**
 * Writes the event AND sends the invitations, so a success can still be
 * partial: `warnings` names what did not happen. Never report this as "invites
 * sent" without reading them.
 */
export function createMeeting(
  body: CreateMeetingBody,
  ctx: Ctx,
): Promise<CreateMeetingResult> {
  return request<CreateMeetingResult>("/api/calendar/meetings", {
    method: "POST",
    body,
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/** Same partial-success rule as createMeeting: read `warnings`. */
export function cancelMeeting(
  meetingId: string,
  ctx: Ctx,
): Promise<MeetingResult> {
  return request<MeetingResult>(
    `/api/calendar/meetings/${encodeURIComponent(meetingId)}/cancel`,
    {
      method: "POST",
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
    },
  );
}

/* -------------------------------------------------------------------------- */
/* updates                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * All four return the same state object, so a command's reply IS the new
 * state and the caller never has to re-read to find out what happened.
 *
 * A server built before this endpoint answers 404. That is a fact about the
 * server, not an error to show: `useUpdate` turns it into "no updater here".
 */
export function getUpdate(ctx: Ctx): Promise<UpdateState> {
  return request<UpdateState>("/api/update", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/**
 * `download` defaults to true on the server: a person who presses a check
 * button wants the update, not a second button. Pass false for a check the
 * user did not press — opening a page is not asking for a 100 MB transfer.
 */
export function checkForUpdate(
  ctx: Ctx,
  options: { download?: boolean } = {},
): Promise<UpdateState> {
  const path =
    options.download === false
      ? "/api/update/check?download=0"
      : "/api/update/check";
  return request<UpdateState>(path, {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/** Returns as soon as the download starts; progress arrives through getUpdate. */
export function downloadUpdate(ctx: Ctx): Promise<UpdateState> {
  return request<UpdateState>("/api/update/download", {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/**
 * The app quits and relaunches into the new version. The reply arrives first,
 * so this resolves — and then the page it was called from goes away with it.
 */
export function installUpdate(ctx: Ctx): Promise<UpdateState> {
  return request<UpdateState>("/api/update/install", {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/* -------------------------------------------------------------------------- */
/* MCP                                                                        */
/* -------------------------------------------------------------------------- */

export type McpTool = { name: string; description?: string };
export type McpToolsListResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: { tools: McpTool[] };
  error?: { code: number; message: string };
};

/**
 * User-triggered only, never on load. POST /mcp is stateless — a response
 * proves the endpoint answers with this token, and nothing more. It never means
 * an agent is connected.
 */
export function mcpToolsList(ctx: Ctx): Promise<McpToolsListResponse> {
  return request<McpToolsListResponse>("/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* the local agent launcher                                                   */
/* -------------------------------------------------------------------------- */

export type LocalAgentModel = { id: string; label: string };

export type LocalAgent = {
  id: string;
  label: string;
  /** The CLI exists on the server machine's PATH. */
  available: boolean;
  /** This Boxaide build knows how to launch it. */
  supported: boolean;
  /** It can carry a scheduled automation run, not only the chat loop. */
  runsAutomations: boolean;
  /** Models the server lets you pick from. Empty means no picker. */
  models: LocalAgentModel[];
};

/**
 * How much of the machine a launched agent may reach. Mirrors AgentAccess in
 * src/agent/sandbox.ts.
 *
 * `workspace` confines it to its own directory and its own CLI's files, and is
 * what every launch gets. `full` is unconfined; nothing in this app asks for
 * it, and a launch only lands there when the install set it or the machine has
 * no sandbox — in which case `accessNotice` says which.
 */
export type LocalAgentAccess = "workspace" | "full";

export type RunningLocalAgent = {
  id: string;
  pid: number;
  startedAt: string;
  model: string | null;
  /** What this launch was actually given, not what was asked for. */
  access: LocalAgentAccess;
  /**
   * Why it is unconfined, when it is. Null on a confined launch, and absent on
   * a server built before this field existed — both mean "say nothing".
   */
  accessNotice?: string | null;
};

/**
 * Why the last launch ended. Mirrors ExitReason in src/agent/launcher.ts.
 *
 * The exit code cannot answer this: a driven agent has no process exit at all,
 * and a child that was asked to stop dies on a signal with no code. Read the
 * reason, not the code, to decide whether something went wrong.
 */
export type LocalAgentExitReason = "stopped" | "error" | "exited";

export type LocalAgentExit = {
  id: string;
  code: number | null;
  reason: LocalAgentExitReason;
  at: string;
  stderrTail: string;
};

export type LocalAgentsResponse = {
  agents: LocalAgent[];
  running: RunningLocalAgent | null;
  lastExit: LocalAgentExit | null;
};

export function listLocalAgents(ctx: Ctx): Promise<LocalAgentsResponse> {
  return request<LocalAgentsResponse>("/api/agents", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

export function startLocalAgent(
  id: string,
  ctx: Ctx,
  model?: string,
): Promise<{ running: RunningLocalAgent }> {
  // Model only. Confinement is not a per-launch request any more: the server
  // decides it from the install and the machine, and a field here would be a
  // second place holding that opinion.
  const body: { model?: string } = {};
  if (model) body.model = model;
  return request<{ running: RunningLocalAgent }>(
    `/api/agents/${encodeURIComponent(id)}/start`,
    {
      method: "POST",
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      signal: ctx.signal,
      body: Object.keys(body).length > 0 ? body : undefined,
    },
  );
}

export function stopLocalAgent(ctx: Ctx): Promise<{ stopping: boolean }> {
  return request<{ stopping: boolean }>("/api/agents/stop", {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

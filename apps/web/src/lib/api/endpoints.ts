/**
 * One typed function per endpoint the app is allowed to touch. Nothing outside
 * this file may call `request`, and nothing anywhere may call `fetch`.
 *
 * Never called from this app:
 *   GET /api/agent-connect  — its response embeds the full bearer token; the
 *     MCP snippet is built client-side from localStorage instead (§6.7).
 *
 * Called from exactly one place, under one condition:
 *   GET /api/local-bootstrap — hands out the token in plaintext. The wizard
 *     calls it only when the page is served same-origin from loopback, i.e.
 *     the page IS the server's own UI (getLocalBootstrap documents the guard).
 */

import { query, request, stream } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { DEFAULT_LIMIT } from "@/lib/constants";
import type {
  AccountCredentials,
  AgentPresence,
  AgentStateResponse,
  AgentTurn,
  ApiHealthResponse,
  ConnectionTestResult,
  CreatedAccount,
  DraftInput,
  DraftRef,
  HealthResponse,
  MailDraft,
  MailFolder,
  MailMessage,
  MailAccountMeta,
  MessageListResponse,
  MetaResponse,
  SendResult,
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
 * The token, in plaintext. The server only answers when the Host header is
 * loopback and the Origin is absent or loopback; the caller must additionally
 * hold to the client-side rule: only when the page's own origin IS `baseUrl`
 * and that origin is loopback. Anywhere else, a human pastes the token.
 */
export function getLocalBootstrap(ctx: Ctx): Promise<LocalBootstrapResponse> {
  return request<LocalBootstrapResponse>("/api/local-bootstrap", {
    baseUrl: ctx.baseUrl,
    token: "",
    signal: ctx.signal,
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

/** History plus presence. `after` asks for turns newer than a sequence number. */
export function getAgentState(ctx: Ctx, after?: number): Promise<AgentStateResponse> {
  return request<AgentStateResponse>(`/api/agent/state${query({ after })}`, {
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
 */
export function sendAgentMessage(
  text: string,
  ctx: Ctx,
): Promise<{ turn: AgentTurn; presence: AgentPresence }> {
  return request<{ turn: AgentTurn; presence: AgentPresence }>("/api/agent/messages", {
    method: "POST",
    body: { text },
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

export function clearAgentConversation(ctx: Ctx): Promise<{ cleared: boolean }> {
  return request<{ cleared: boolean }>("/api/agent/clear", {
    method: "POST",
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
  });
}

/**
 * Follow the conversation. Resolves when the server closes the stream; the
 * caller reconnects.
 */
export function streamAgent(
  ctx: Ctx,
  on: { turn: (turn: AgentTurn) => void; presence: (presence: AgentPresence) => void },
): Promise<void> {
  return stream("/api/agent/stream", {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    signal: ctx.signal,
    onEvent: (event, data) => {
      try {
        if (event === "turn") on.turn(JSON.parse(data) as AgentTurn);
        else if (event === "presence") on.presence(JSON.parse(data) as AgentPresence);
      } catch {
        // A frame we cannot parse is dropped rather than tearing down a live
        // conversation. The next one re-states presence anyway.
      }
    },
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

export type LocalAgent = {
  id: string;
  label: string;
  /** The CLI exists on the server machine's PATH. */
  available: boolean;
  /** This mailmux build knows how to launch it. */
  supported: boolean;
};

export type RunningLocalAgent = { id: string; pid: number; startedAt: string };

export type LocalAgentExit = {
  id: string;
  code: number | null;
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
): Promise<{ running: RunningLocalAgent }> {
  return request<{ running: RunningLocalAgent }>(
    `/api/agents/${encodeURIComponent(id)}/start`,
    { method: "POST", baseUrl: ctx.baseUrl, token: ctx.token, signal: ctx.signal },
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

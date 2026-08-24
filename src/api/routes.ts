import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentChannel, Turn } from "../agent/channel.js";
import { LaunchError, type AgentLauncher } from "../agent/launcher.js";
import { ApprovalError, type ApprovalQueue } from "../agent/approvals.js";
import type { ArchiveLog } from "../agent/archive-log.js";
import type { MailService } from "../mail/service.js";
import type { Platform } from "../platform.js";
import { registerCrmRoutes } from "../crm/routes.js";
import { registerAutomationRoutes } from "../automation/routes.js";
import { registerMemoryRoutes } from "../memory/routes.js";
import { registerOutreachRoutes } from "../outreach/routes.js";
import { registerConnectorRoutes } from "../connectors/routes.js";
import {
  registerCalendarRoutes,
  type CalendarRouteConfig,
} from "../calendar/routes.js";
import { registerUpdateRoutes } from "../update/routes.js";
import type { UpdateService } from "../update/service.js";
import { appVersion } from "../version.js";
import type { AccountCredentials, DraftInput } from "../provider/types.js";
import { parseAttachments, passwordCredentials } from "../provider/types.js";
import { MAX_LIST_LIMIT, parseListLimit } from "../input-limits.js";

/** Highest `limit` any list endpoint will accept. */
export const MAX_LIMIT = MAX_LIST_LIMIT;

/** REST body fields for connect/test — still flat username/password for the UI. */
type ConnectCredentialFields = {
  imapHost: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username?: string;
  password?: string;
  /** Optional already-shaped auth. Only `kind: "password"` is accepted today. */
  auth?: AccountCredentials["auth"];
};

type ConnectAccountBody = ConnectCredentialFields & {
  alias: string;
  email: string;
};

export type ConnectCredentialsResult =
  | { ok: true; creds: AccountCredentials }
  | { ok: false; error: string };

const MISSING_CREDENTIALS =
  "credentials required: username and password, or auth { kind: 'password', user, pass }";

/**
 * XOAUTH2 is a valid MailAuth kind inside the provider and the store, but the
 * REST surface refuses it. An access token expires in about an hour and the
 * store has nowhere to keep a refresh token, so an account created this way
 * would die with no recovery except delete and re-create. Open this up in the
 * same change that adds token refresh.
 */
const XOAUTH2_NOT_ACCEPTED =
  "xoauth2 is not accepted yet: no token refresh exists, so the account would stop working when the token expires";

/**
 * Map a connect/test body to AccountCredentials.
 * Prefer explicit `auth`; fall back to username+password for the web form.
 */
export function parseConnectCredentials(
  body: ConnectCredentialFields,
): ConnectCredentialsResult {
  const hosts = {
    imapHost: body.imapHost,
    imapPort: body.imapPort ?? 993,
    imapSecure: body.imapSecure ?? true,
    smtpHost: body.smtpHost,
    smtpPort: body.smtpPort ?? 465,
    smtpSecure: body.smtpSecure ?? true,
  };
  if (!hosts.imapHost || !hosts.smtpHost) {
    return { ok: false, error: "imapHost and smtpHost are required" };
  }
  if (body.auth) {
    if (body.auth.kind === "xoauth2") {
      return { ok: false, error: XOAUTH2_NOT_ACCEPTED };
    }
    if (body.auth.kind === "password") {
      if (!body.auth.user || !body.auth.pass) {
        return { ok: false, error: MISSING_CREDENTIALS };
      }
      return { ok: true, creds: { ...hosts, auth: body.auth } };
    }
    return { ok: false, error: MISSING_CREDENTIALS };
  }
  if (!body.username || body.password === undefined || body.password === "") {
    return { ok: false, error: MISSING_CREDENTIALS };
  }
  return {
    ok: true,
    creds: passwordCredentials({
      ...hosts,
      user: body.username,
      pass: body.password,
    }),
  };
}

/** Draft create/update body. `account` is ignored on the update route. */
type DraftBody = DraftInput & { account?: string };

/**
 * Pick the draft fields explicitly, exactly as the send route does, so nothing
 * else a client posts reaches the MIME composer.
 */
function draftFieldsOf(body: DraftBody): DraftInput {
  return {
    to: body.to,
    subject: body.subject,
    text: body.text,
    html: body.html,
    cc: body.cc,
    bcc: body.bcc,
    inReplyTo: body.inReplyTo,
    references: body.references,
    attachments: parseAttachments(body.attachments),
  };
}

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Strip an optional `:port`, leaving bracketed and bare IPv6 literals intact. */
function hostnameOf(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  if (colon === -1) return host;
  // More than one colon means a bare IPv6 literal, which carries no port.
  if (host.indexOf(":", colon + 1) !== -1) return host;
  return host.slice(0, colon);
}

/**
 * True only when the Host header names the loopback interface exactly.
 * Prefix matching is not safe here: `localhost.evil.com` resolves to an
 * attacker-controlled host that points at 127.0.0.1, so it must not pass.
 */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  return LOCAL_HOSTNAMES.has(hostnameOf(host));
}

/**
 * True only when the server's own bind address is loopback.
 *
 * The Host and Origin checks on /api/local-bootstrap are network guards, not
 * identity. A remote client on a `0.0.0.0` bind can send `Host: localhost`
 * and no Origin, so the bind address itself still decides whether the
 * desktop-capability endpoint exists.
 *
 * Any 127.0.0.0/8 address counts, not just 127.0.0.1 — the whole block is
 * loopback-only. An empty or `*` host means "every interface" and fails.
 */
export function isLoopbackBindAddress(host: string | undefined): boolean {
  if (!host) return false;
  const value = hostnameOf(host).replace(/^\[|\]$/g, "");
  if (value === "localhost" || value === "::1") return true;
  // Octets are checked numerically. A digit-count pattern would accept
  // 127.999.999.999, which is not an address at all — and this function
  // decides whether the token endpoint exists.
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  if (octets[0] !== "127") return false;
  return octets.every(
    (part) =>
      /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
  );
}

/**
 * Browser CSRF guard. Requests with no Origin (curl, MCP clients) pass;
 * a present Origin must be loopback.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/** CORS response headers shared by preflight and real responses. */
// PATCH is here because the web UI edits automations with it
// (/api/automations/:id); an allowlisted
// hosted origin cannot reach those routes if the preflight omits the method.
// PUT is here for the same reason: the Connectors panel saves provider API
// keys with PUT /api/connectors/:id.
const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "authorization, content-type";
// A day, not ten minutes. The web app defaults to a different origin than the
// API (apps/web/src/lib/constants.ts) and every request carries an
// Authorization header, so each distinct URL is preflighted — at ten minutes
// the whole cold-open round-trip count was paid twice, again every ten minutes.
// The allowlist is enforced per request, so a long-lived preflight cache never
// widens what an origin may reach.
const CORS_MAX_AGE = "86400";

/**
 * Origin gate for the *authenticated* API. Loopback always passes, so the
 * self-hosted UI needs no configuration. Everything else must be an exact
 * origin match from the allowlist. Requests with no Origin (curl, MCP
 * clients, stdio) pass, exactly as before.
 *
 * NOT used by /api/local-bootstrap: that route has a narrower loopback plus
 * one-time desktop-capability policy.
 */
export function isApiOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined || origin === "") return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) return true;
  return allowed.includes(url.origin.toLowerCase());
}

/**
 * Stamp CORS headers on an outgoing response. Vary is set unconditionally —
 * including on denials — so no cache can serve one origin's answer to another.
 * Allow-Credentials is deliberately never sent: Boxaide authenticates by
 * header, never by cookie, so ambient credentials must not be possible.
 *
 * Never echoes "*": an allowlist that answers every origin is not an
 * allowlist.
 *
 * The header carries the *parsed* origin, never the raw request header.
 * isApiOriginAllowed compares `new URL(origin).origin`, and the WHATWG parser
 * treats a backslash as a slash — so `https://good.example\.evil.com` parses to
 * `https://good.example`, passes the allowlist, and echoing the raw string
 * would hand that response to the attacker's origin. No browser emits such an
 * Origin today, but a proxy that forwards a client-set one would.
 */
export function applyCors(c: Context, origin: string | undefined): void {
  setHeader(c, "Vary", "Origin");
  if (!origin) return;
  let serialized: string;
  try {
    serialized = new URL(origin).origin;
  } catch {
    return;
  }
  if (serialized === "null") return;
  setHeader(c, "Access-Control-Allow-Origin", serialized);
}

/**
 * `c.header()` writes into the prepared-header bag, which is only merged when
 * Hono builds the response. After `await next()` the response already exists,
 * so the header has to go straight onto it.
 */
function setHeader(c: Context, name: string, value: string): void {
  if (c.finalized) {
    c.res.headers.set(name, value);
    return;
  }
  c.header(name, value);
}

/** 204 answer to a CORS preflight. Carries no body and no auth requirement. */
export function corsPreflight(
  c: Context,
  origin: string | undefined,
): Response {
  applyCors(c, origin);
  c.header("Access-Control-Allow-Methods", CORS_METHODS);
  c.header("Access-Control-Allow-Headers", CORS_HEADERS);
  c.header("Access-Control-Max-Age", CORS_MAX_AGE);
  return c.body(null, 204);
}

/** 403 for an origin that is not loopback and not on the allowlist. */
export function forbiddenOrigin(c: Context): Response {
  applyCors(c, undefined); // Vary only — never echo a rejected origin
  return c.json({ error: "forbidden origin" }, 403);
}

/** Answer an OPTIONS preflight, or 403 when the origin is not allowlisted. */
export function corsPreflightOrDeny(
  c: Context,
  allowedOrigins: readonly string[],
): Response {
  const origin = c.req.header("origin");
  if (!isApiOriginAllowed(origin, allowedOrigins)) return forbiddenOrigin(c);
  return corsPreflight(c, origin);
}

/**
 * Origin gate for unauthenticated routes registered outside `createApi`
 * (`/health`). Returns a response to send, or null to proceed with the CORS
 * headers already stamped.
 */
export function corsGate(
  c: Context,
  allowedOrigins: readonly string[],
): Response | null {
  const origin = c.req.header("origin");
  if (!isApiOriginAllowed(origin, allowedOrigins)) return forbiddenOrigin(c);
  applyCors(c, origin);
  return null;
}

/** Constant-time bearer comparison; a length mismatch fails without leaking. */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Single auth gate for every protected route. Returns a response to send,
 * or null when the request may proceed. Header only — never `?token=`,
 * which leaks into shell history, proxy logs and Referer headers.
 */
export function authFailure(
  c: Context,
  expected: string,
  allowedOrigins: readonly string[],
): Response | null {
  const origin = c.req.header("origin");
  if (!isApiOriginAllowed(origin, allowedOrigins)) {
    return forbiddenOrigin(c);
  }
  const header = c.req.header("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!tokensMatch(bearer, expected)) {
    applyCors(c, origin);
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}

/** Returns the limit, or null when the raw value is not a usable number. */
function parseLimit(raw: string | undefined): number | null {
  return parseListLimit(raw, 50);
}

/**
 * `allowedOrigins` is required on purpose. A default of `[]` fails closed, but
 * it fails closed silently: a new call site that forgets the argument loses the
 * allowlist and the compiler stays quiet.
 */
export function createApi(
  mail: MailService,
  bearerToken: string,
  allowedOrigins: readonly string[],
  channel?: AgentChannel,
  launcher?: AgentLauncher,
  platform?: Platform,
  update?: UpdateService,
  /**
   * Actions an agent asked a person to authorise. Absent on a server with no
   * conversation, where nothing can be queued in the first place.
   */
  approvals?: ApprovalQueue,
  /**
   * The address the server is actually reachable on. Only the calendar's
   * Google OAuth flow needs it: the redirect URI it hands Google must match
   * the one the callback later exchanges with, byte for byte. Absent, the
   * calendar routes are registered against the loopback default.
   */
  address?: CalendarRouteConfig,
): Hono {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    // Preflight is answered before auth on purpose: a preflight carries no
    // Authorization header by spec, so gating it on the token makes CORS
    // impossible. The origin allowlist is the control that matters here.
    if (c.req.method === "OPTIONS") {
      return corsPreflightOrDeny(c, allowedOrigins);
    }
    const failure = authFailure(c, bearerToken, allowedOrigins);
    if (failure) return failure;
    await next();
    applyCors(c, origin);
  });

  // The version is the running build's, read from package.json. It was the
  // literal "0.1.0" through every release up to 0.2.9 — which is exactly the
  // kind of stale answer an update check must not be built on.
  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "boxaide", version: appVersion() }),
  );

  app.get("/api/meta", (c) =>
    c.json({
      tokenHint: `${bearerToken.slice(0, 4)}…`,
      mcpPath: "/mcp",
      auth: "Authorization: Bearer <token>  (token also in data dir bearer.token)",
    }),
  );

  app.get("/api/accounts", (c) => {
    return c.json({ accounts: mail.listAccounts() });
  });

  app.post("/api/accounts", async (c) => {
    const body = await c.req.json<ConnectAccountBody>();
    const parsed = parseConnectCredentials(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const account = await mail.connectAccount({
        alias: body.alias,
        email: body.email,
        creds: parsed.creds,
      });
      return c.json({ account }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/accounts/test", async (c) => {
    const body = await c.req.json<ConnectCredentialFields>();
    const parsed = parseConnectCredentials(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const result = await mail.testCredentials(parsed.creds);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.delete("/api/accounts/:id", (c) => {
    const ok = mail.removeAccount(c.req.param("id"));
    return c.json({ deleted: ok }, ok ? 200 : 404);
  });

  app.get("/api/messages", async (c) => {
    const account = c.req.query("account") ?? "all";
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json(
        { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        400,
      );
    }
    const folder = c.req.query("folder") ?? undefined;
    const unreadOnly = c.req.query("unread") === "1";
    try {
      const { messages, errors } = await mail.listMessages(account, {
        limit,
        folder,
        unreadOnly,
      });
      return c.json({ messages, errors });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get("/api/messages/search", async (c) => {
    const account = c.req.query("account") ?? "all";
    const query = c.req.query("q") ?? "";
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json(
        { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        400,
      );
    }
    if (!query) return c.json({ error: "q is required" }, 400);
    try {
      const { messages, errors } = await mail.searchMessages(account, {
        query,
        limit,
      });
      return c.json({ messages, errors });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get("/api/folders", async (c) => {
    const account = c.req.query("account") ?? "";
    // Empty still 400s, "all" no longer does: the rail draws every mailbox at
    // once and needs to know which folder belongs to which account.
    if (!account) {
      return c.json({ error: "account is required" }, 400);
    }
    try {
      const result = await mail.listFolderTree(account);
      if (account === "all") return c.json(result);
      // One named mailbox keeps answering with the flat { folders } array. The
      // command palette, the reader's move menu and use-move all read that
      // shape, and only "all" needs the grouping.
      return c.json({ folders: result.groups[0]?.folders ?? [] });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get("/api/messages/:accountId/:messageId", async (c) => {
    try {
      const message = await mail.getMessage(
        c.req.param("accountId"),
        decodeURIComponent(c.req.param("messageId")),
      );
      if (!message) return c.json({ error: "not found" }, 404);
      return c.json({ message });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/messages/:accountId/:messageId/read", async (c) => {
    try {
      const body = await c.req.json<{ seen?: unknown }>();
      if (typeof body.seen !== "boolean") {
        return c.json({ error: "seen must be a boolean" }, 400);
      }
      const updated = await mail.markRead(
        c.req.param("accountId"),
        decodeURIComponent(c.req.param("messageId")),
        body.seen,
      );
      if (!updated) return c.json({ error: "not found" }, 404);
      return c.json({ updated, seen: body.seen });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /**
   * Archive one message: a move into the account's Archive mailbox, never a
   * delete. The response names both mailboxes, so the caller can offer an undo
   * that puts the message back where it came from.
   *
   * 404 means the uid was already gone from the source folder — another client
   * moved it first — and nothing was written.
   */
  app.post("/api/messages/:accountId/:messageId/archive", async (c) => {
    try {
      const result = await mail.archiveMessage(
        c.req.param("accountId"),
        decodeURIComponent(c.req.param("messageId")),
      );
      if (!result.moved) return c.json({ error: "not found" }, 404);
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /**
   * Delete one message: a move into the account's Trash mailbox, never an IMAP
   * expunge. The response names both mailboxes, so the caller can offer an undo
   * that puts the message back where it came from.
   *
   * 404 means the uid was already gone from the source folder, and nothing was
   * written. 400 carries the reason a server with no Trash mailbox refused.
   */
  app.post("/api/messages/:accountId/:messageId/trash", async (c) => {
    try {
      const result = await mail.trashMessage(
        c.req.param("accountId"),
        decodeURIComponent(c.req.param("messageId")),
      );
      if (!result.moved) return c.json({ error: "not found" }, 404);
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /**
   * Move one message to a named mailbox. This is what an archive's Undo posts,
   * with the `fromFolder` the archive handed back.
   */
  app.post("/api/messages/:accountId/:messageId/move", async (c) => {
    try {
      const body = await c.req.json<{ folder?: unknown }>();
      if (typeof body.folder !== "string" || !body.folder.trim()) {
        return c.json({ error: "folder must be a non-empty string" }, 400);
      }
      const result = await mail.moveMessage(
        c.req.param("accountId"),
        decodeURIComponent(c.req.param("messageId")),
        body.folder,
      );
      if (!result.moved) return c.json({ error: "not found" }, 404);
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get("/api/drafts", async (c) => {
    const account = c.req.query("account") ?? "";
    if (!account || account === "all") {
      return c.json({ error: "account is required" }, 400);
    }
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json(
        { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        400,
      );
    }
    try {
      return c.json({ drafts: await mail.listDrafts(account, { limit }) });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/drafts", async (c) => {
    const body = await c.req.json<DraftBody>();
    if (!body.account) return c.json({ error: "account is required" }, 400);
    try {
      const draft = await mail.createDraft(body.account, draftFieldsOf(body));
      return c.json({ draft }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  // POST, not PUT: the CORS allow-list of methods carries only the verbs the
  // UI actually sends (PATCH is there for automations; PUT is
  // not), and a draft update is a replace-and-delete rather than an idempotent
  // write.
  app.post("/api/drafts/:accountId/:draftId", async (c) => {
    const body = await c.req.json<DraftBody>();
    try {
      const draft = await mail.updateDraft(
        c.req.param("accountId"),
        decodeURIComponent(c.req.param("draftId")),
        draftFieldsOf(body),
      );
      return c.json({ draft });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.delete("/api/drafts/:accountId/:draftId", async (c) => {
    try {
      const deleted = await mail.deleteDraft(
        c.req.param("accountId"),
        decodeURIComponent(c.req.param("draftId")),
      );
      if (!deleted) return c.json({ error: "not found" }, 404);
      return c.json({ deleted });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/messages/send", async (c) => {
    const body = await c.req.json<{
      account: string;
      to: string;
      subject: string;
      text: string;
      html?: string;
      cc?: string;
      bcc?: string;
      inReplyTo?: string;
      references?: string;
      attachments?: unknown;
      overrideSuppression?: unknown;
    }>();
    // The suppression override is a human decision, so only this REST route
    // reads it — the MCP message_send tool has no such flag. Strict `=== true`
    // keeps a stray "false", 0, or null from ever reading as consent.
    const overrideSuppression = body.overrideSuppression === true;
    try {
      const result = await mail.sendMessage(
        body.account,
        {
          to: body.to,
          subject: body.subject,
          text: body.text,
          html: body.html,
          cc: body.cc,
          bcc: body.bcc,
          inReplyTo: body.inReplyTo,
          references: body.references,
          attachments: parseAttachments(body.attachments),
        },
        { overrideSuppression },
      );
      return c.json({ result }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /* ---- the agent conversation ------------------------------------------
     Registered only when the runtime built a channel. Without one these paths
     404 rather than 500, and the UI's own capability check is the same
     question: does this server have an agent channel at all?
     --------------------------------------------------------------------- */
  if (channel)
    registerAgentRoutes(app, channel, approvals, launcher, platform?.archiveLog);
  if (approvals) registerApprovalRoutes(app, approvals);
  if (launcher) registerLauncherRoutes(app, launcher);
  // Agent platform routes (CRM, automations, outreach). Registered inside
  // createApi so the /api/* auth middleware above gates all of them.
  if (platform) {
    registerCrmRoutes(app, platform);
    registerAutomationRoutes(app, platform);
    registerMemoryRoutes(app, platform);
    registerOutreachRoutes(app, platform);
    registerConnectorRoutes(app, platform);
    registerCalendarRoutes(app, platform, address ?? { host: "127.0.0.1", port: 8787 });
  }
  // Absent in an embedder that builds its own API (tests, `boxaide mcp`), so
  // the UI's "is there an updater here" question is answered by a 404 rather
  // than by a state object that describes nothing.
  if (update) registerUpdateRoutes(app, update);

  return app;
}

/** Longest a message from the composer may be. Well past any real question. */
const MAX_CHAT_CHARS = 8_000;

/**
 * Heartbeat interval for the SSE stream.
 *
 * A stream that sends nothing for minutes is indistinguishable from a dead one,
 * and intermediaries close idle connections. The comment frame costs two bytes
 * of payload and keeps `onerror`-driven reconnect logic honest.
 */
const SSE_HEARTBEAT_MS = 20_000;

/**
 * Approve or drop what an agent asked for.
 *
 * Two routes and no list route: the pending set rides on `/api/agent/state`
 * and on the stream beside presence, because it is drawn in the conversation
 * and a second poll would let the card and the transcript disagree.
 */
function registerApprovalRoutes(app: Hono, approvals: ApprovalQueue): void {
  app.post("/api/agent/approvals/:id", async (c) => {
    let decision: unknown;
    try {
      const body = await c.req.json<{ decision?: unknown }>();
      decision = body?.decision;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (decision !== "approve" && decision !== "deny") {
      return c.json({ error: "decision must be approve or deny" }, 400);
    }
    try {
      const result = await approvals.decide(c.req.param("id"), decision);
      return c.json({ ...result, pending: approvals.pending() });
    } catch (err) {
      if (err instanceof ApprovalError) {
        // 502 carries the send's own failure text. It is the one the user has
        // to read — "could not approve" would hide the SMTP error inside it.
        return c.json(
          { error: err.message, pending: approvals.pending() },
          err.status as 404 | 409 | 502,
        );
      }
      throw err;
    }
  });
}

function registerAgentRoutes(
  app: Hono,
  channel: AgentChannel,
  approvals?: ApprovalQueue,
  launcher?: AgentLauncher,
  archiveLog?: ArchiveLog | null,
): void {
  /**
   * Put back everything one agent sweep archived.
   *
   * The per-message Undo lives on a toast, in a window nobody watches while an
   * agent works through an inbox. This is the same undo at the size the sweep
   * actually was. Partial success is normal and is reported as counts: the
   * mail has been sitting in the Archive mailbox where any other client could
   * have moved it.
   */
  app.post("/api/agent/archives/:id/undo", async (c) => {
    if (!archiveLog) return c.json({ error: "not available" }, 404);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad sweep id" }, 400);
    try {
      const result = await archiveLog.undo(id);
      return c.json({ ...result, sweeps: archiveLog.sweeps() });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  });

  app.get("/api/agent/state", (c) => {
    const after = c.req.query("after");
    const afterSeq = after !== undefined && /^\d+$/.test(after) ? Number(after) : undefined;
    // `chat` is the pane telling the server which conversation it is showing.
    // Without it the answer is the active one, which is what a fresh client
    // wants and what every caller before chats existed asked for.
    const asked = c.req.query("chat") ?? undefined;
    const shown = asked
      ? channel.chats({ includeArchived: true }).find((row) => row.id === asked)
      : channel.activeChat();
    if (!shown) return c.json({ error: "no such chat" }, 404);
    return c.json({
      turns: channel.history(afterSeq, shown.id),
      presence: channel.presence(),
      chat: shown,
      approvals: approvals?.pending() ?? [],
      // Rides on state for the same reason the approvals do: it is drawn in
      // the conversation, and a second poll would let the two disagree.
      archiveSweeps: archiveLog?.sweeps() ?? [],
    });
  });

  /* ---- chats -------------------------------------------------------------
     The rail shows the newest few and the dialog shows the rest, so the list
     is returned whole: it is one small row per conversation, and paginating it
     would buy nothing but a second round trip for the search box.
     --------------------------------------------------------------------- */

  app.get("/api/agent/chats", (c) => {
    const archived = c.req.query("archived") === "1";
    return c.json({
      chats: channel.chats({ includeArchived: archived }),
      storage: channel.storage(),
    });
  });

  app.post("/api/agent/chats", (c) =>
    c.json({ chat: channel.createChat(), storage: channel.storage() }, 201),
  );

  app.post("/api/agent/chats/:id/select", (c) => {
    if (!channel.selectChat(c.req.param("id"))) {
      return c.json({ error: "no such chat" }, 404);
    }
    return c.json({ chat: channel.activeChat() });
  });

  app.patch("/api/agent/chats/:id", async (c) => {
    let body: { title?: unknown };
    try {
      body = await c.req.json<{ title?: unknown }>();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return c.json({ error: "title is required" }, 400);
    if (!channel.renameChat(c.req.param("id"), title)) {
      return c.json({ error: "no such chat" }, 404);
    }
    return c.json({ renamed: true });
  });

  /* Archiving keeps every message and Unarchive is its undo, so both are plain
     state changes on the row rather than anything that touches the turns. A
     chat that is already in the state being asked for answers 404: the caller
     is working from a list that has moved on. */
  app.post("/api/agent/chats/:id/archive", (c) => {
    if (!channel.archiveChat(c.req.param("id"))) {
      return c.json({ error: "no such chat" }, 404);
    }
    return c.json({ archived: true, storage: channel.storage() });
  });

  app.post("/api/agent/chats/:id/unarchive", (c) => {
    if (!channel.unarchiveChat(c.req.param("id"))) {
      return c.json({ error: "no such chat" }, 404);
    }
    return c.json({ archived: false, storage: channel.storage() });
  });

  app.delete("/api/agent/chats/:id", (c) => {
    if (!channel.deleteChat(c.req.param("id"))) {
      return c.json({ error: "no such chat" }, 404);
    }
    return c.json({ deleted: true, storage: channel.storage() });
  });

  app.post("/api/agent/messages", async (c) => {
    let body: { text?: unknown; chat?: unknown };
    try {
      body = await c.req.json<{ text?: unknown; chat?: unknown }>();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text is required" }, 400);
    if (text.length > MAX_CHAT_CHARS) {
      return c.json({ error: `text must be ${MAX_CHAT_CHARS} characters or fewer` }, 400);
    }
    // Same rule as the state route: `chat` is the pane saying which
    // conversation it is showing, and a client from before chats existed sends
    // none and gets the active one.
    const chatId = typeof body.chat === "string" ? body.chat : undefined;
    if (chatId && !channel.writable(chatId)) {
      return c.json({ error: "no such chat" }, 404);
    }
    const turn = channel.post({ role: "user", text, chatId });
    // The presence that ships with the write is what the composer uses to say
    // "no agent is listening" the moment a message lands unheard.
    return c.json({ turn, presence: channel.presence() }, 201);
  });

  /**
   * Stop the message being answered right now.
   *
   * The channel goes first and the CLI second. Closing the message is what
   * makes this a stop rather than a restart: a lease given back is handed
   * straight to the agent that was just killed, so the run the user stopped
   * would begin again a moment later. With the question answered, the killed
   * turn's release is a no-op and the loop goes back to waiting.
   *
   * `stopped` is false when the message named by `seq` is not the one in
   * flight: the answer landed while the button was being pressed, and the next
   * message was claimed behind it. Stopping that one instead would kill a run
   * in a conversation the user never looked at.
   *
   * `stopped` is otherwise whether anything was in flight, not whether a CLI
   * was killed.
   * An agent that connected over MCP is another process's to interrupt — the
   * message is closed here either way, so the pane stops waiting on an answer
   * that is no longer coming.
   */
  app.post("/api/agent/stop", async (c) => {
    // A body is optional, and `seq` in it is the message the pane was showing
    // Stop for. Without it this stops whatever is in flight, which is what a
    // client that cannot name one has to mean.
    const body = await c.req.json<{ seq?: unknown }>().catch(() => ({}) as { seq?: unknown });
    if (body.seq !== undefined && typeof body.seq !== "number") {
      return c.json({ error: "seq must be a number" }, 400);
    }
    const seq = typeof body.seq === "number" ? body.seq : undefined;
    const work = channel.cancelWork(seq);
    if (work) launcher?.interrupt(work.seq);
    return c.json({ stopped: work !== null, presence: channel.presence() });
  });

  /**
   * Offer one message to an agent again.
   *
   * The pane's Retry, for a question that was dropped or that died with the
   * CLI answering it. `requeueTurn` is the whole state change; 409 is it
   * refusing, and the sentence is what the pane shows, because "nothing
   * happened" under a button the user just pressed is the worst answer here.
   *
   * The launch is second and optional. A requeued message sitting in front of
   * a dead CLI is the exact state the user pressed Retry to leave, so the
   * agent the pane has selected is started for them, by the same call the
   * start route makes, with the same registry check on the id. It is skipped when
   * something is already running, since that agent takes the message anyway,
   * and a launch that refuses does not undo the requeue: the message is back
   * in the queue either way, and `startError` says why nobody picked it up.
   *
   * A row an agent is still working counts as retryable too. From the pane a
   * live lease and a dropped one look alike, and pressing Retry declares this
   * attempt over; if the holder was in fact still going, its answer arrives
   * beside whatever answers the requeue — the user's word outranks the lease.
   */
  app.post("/api/agent/retry", async (c) => {
    const body = await c.req
      .json<{ seq?: unknown; agent?: unknown; model?: unknown }>()
      .catch(() => ({}) as { seq?: unknown; agent?: unknown; model?: unknown });
    if (typeof body.seq !== "number") {
      return c.json({ error: "seq must be a number" }, 400);
    }
    if (body.agent !== undefined && typeof body.agent !== "string") {
      return c.json({ error: "agent must be a string" }, 400);
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      return c.json({ error: "model must be a string" }, 400);
    }
    if (!channel.requeueTurn(body.seq)) {
      return c.json(
        {
          error:
            "this message cannot be sent again: it was already answered, is no longer here, or is too old",
        },
        409,
      );
    }

    let started = false;
    let startError: string | null = null;
    if (launcher && body.agent && !launcher.status().running) {
      try {
        await launcher.start(body.agent, body.model);
        started = true;
      } catch (err) {
        if (!(err instanceof LaunchError)) throw err;
        // 409 is an agent that started between the check and the call, which
        // is the outcome this wanted anyway.
        if (err.status !== 409) startError = err.message;
      }
    }
    return c.json({ retried: true, started, startError, presence: channel.presence() });
  });

  app.post("/api/agent/clear", async (c) => {
    // A body is optional here: clear predates chats and older clients send
    // none, so an unreadable body means "the chat on screen is the active one".
    const body = await c.req.json<{ chat?: unknown }>().catch(() => ({}) as { chat?: unknown });
    const chatId = typeof body.chat === "string" ? body.chat : undefined;
    if (chatId && !channel.writable(chatId)) {
      return c.json({ error: "no such chat" }, 404);
    }
    channel.clear(chatId);
    return c.json({ cleared: true });
  });

  /**
   * The live conversation.
   *
   * Read with fetch, not EventSource: EventSource cannot send an Authorization
   * header, and the only alternative — the bearer token in the query string —
   * would put it in every access log and in browser history. The client reads
   * the body stream and parses the frames itself.
   */
  app.get("/api/agent/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: Turn[] = [];
      let wake: (() => void) | null = null;
      let presenceDirty = false;

      const unsubscribe = channel.subscribe((turn) => {
        queue.push(turn);
        wake?.();
      });
      const unsubscribePresence = channel.subscribePresence(() => {
        presenceDirty = true;
        wake?.();
      });
      // Chats change on their own — a message renames one, the budget archives
      // another — so the rail is told rather than left to poll for it.
      let chatsDirty = false;
      const unsubscribeChats = channel.subscribeChats(() => {
        chatsDirty = true;
        wake?.();
      });
      // A card appears when an agent asks and disappears when the user
      // answers, and either can happen while nothing else in the pane moves.
      let approvalsDirty = false;
      const unsubscribeApprovals =
        approvals?.subscribe(() => {
          approvalsDirty = true;
          wake?.();
        }) ?? (() => {});

      // `onAbort` is the only close signal that fires for a client that simply
      // went away — the write below can stay pending indefinitely otherwise.
      let open = true;
      const detach = () => {
        unsubscribe();
        unsubscribePresence();
        unsubscribeChats();
        unsubscribeApprovals();
      };
      stream.onAbort(() => {
        open = false;
        detach();
        wake?.();
      });

      await stream.writeSSE({
        event: "presence",
        data: JSON.stringify(channel.presence()),
      });
      // Sent once on attach, not only on change: a request queued overnight is
      // waiting before this stream existed, and a client that only followed
      // changes would show an empty pane over a pending send.
      if (approvals) {
        await stream.writeSSE({
          event: "approvals",
          data: JSON.stringify(approvals.pending()),
        });
      }

      try {
        while (open) {
          while (queue.length > 0 && open) {
            const turn = queue.shift() as Turn;
            await stream.writeSSE({ event: "turn", data: JSON.stringify(turn) });
            presenceDirty = true;
          }
          if (!open) break;
          if (approvalsDirty && approvals) {
            approvalsDirty = false;
            await stream.writeSSE({
              event: "approvals",
              data: JSON.stringify(approvals.pending()),
            });
          }
          if (!open) break;
          if (chatsDirty) {
            chatsDirty = false;
            await stream.writeSSE({
              event: "chats",
              data: JSON.stringify({
                chats: channel.chats(),
                storage: channel.storage(),
              }),
            });
          }
          if (!open) break;
          if (presenceDirty) {
            await stream.writeSSE({
              event: "presence",
              data: JSON.stringify(channel.presence()),
            });
            presenceDirty = false;
            // A waiter can land while this frame is flushing; re-check
            // before parking on the heartbeat.
            continue;
          }
          // Wake on the next turn, a presence change, or the heartbeat.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = null;
              resolve();
            }, SSE_HEARTBEAT_MS);
            wake = () => {
              clearTimeout(timer);
              wake = null;
              resolve();
            };
          });
          if (!open) break;
          if (queue.length === 0 && !presenceDirty) {
            await stream.writeSSE({
              event: "presence",
              data: JSON.stringify(channel.presence()),
            });
          }
        }
      } finally {
        detach();
      }
    }),
  );
}

/**
 * The local agent launcher. All three routes sit behind the /api/* auth
 * middleware like everything else in createApi. Only registry ids reach the
 * launcher; nothing from a request ever becomes part of a command line.
 */
function registerLauncherRoutes(app: Hono, launcher: AgentLauncher): void {
  // ?refresh=1 drops the cached model lists first, so a user who just updated
  // a CLI can see its new models without waiting out the cache TTL.
  app.get("/api/agents", async (c) => {
    if (c.req.query("refresh") === "1") launcher.refreshModels();
    return c.json({ agents: await launcher.list(), ...launcher.status() });
  });

  app.post("/api/agents/:id/start", async (c) => {
    // Body is optional: { model?: string }. The launcher validates the id
    // against its own registry; this only rejects shapes it would not
    // understand. There is no `access` field any more — how much of the disk a
    // launch reaches is decided by the install and the machine, not by the
    // request. See src/agent/sandbox.ts.
    let model: string | undefined;
    try {
      const body = await c.req.json<{ model?: unknown }>();
      if (body && typeof body === "object" && body.model !== undefined) {
        if (typeof body.model !== "string") {
          return c.json({ error: "model must be a string" }, 400);
        }
        model = body.model;
      }
    } catch {
      // No body, or not JSON — start on the CLI's default model.
    }
    try {
      const running = await launcher.start(c.req.param("id"), model);
      return c.json({ running }, 201);
    } catch (err) {
      if (err instanceof LaunchError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  });

  app.post("/api/agents/stop", (c) => {
    launcher.stop();
    return c.json({ stopping: true });
  });

  // One watcher per server, so pressing the button twice does not leave two
  // relaunches racing for the chat slot. Held here rather than at module scope
  // because every runtime gets its own routes and its own launcher.
  let watching: (() => void) | null = null;

  /**
   * Opens a terminal on `claude /login`, and relaunches the agent when the
   * login lands.
   *
   * Signing in cannot happen inside Boxaide: it is an interactive OAuth flow
   * with a browser and a paste-back, and `claude` runs it in its own terminal
   * UI. What Boxaide can do is start that terminal for the user and then stop
   * making them come back — the agent they were talking to gets restarted for
   * them, on the model they had picked, and the messages the signed-out run
   * dropped are requeued by the launch itself (AgentChannel.requeueDropped).
   *
   * macOS only, and it says so instead of pretending. There is no portable
   * "open a terminal here": the Linux answer is a guess among a dozen terminal
   * emulators, and a wrong guess is a button that silently does nothing.
   */
  app.post("/api/agents/claude-code/signin", (c) => {
    if (process.platform !== "darwin") {
      return c.json(
        {
          error:
            "opening a terminal is only wired up on macOS: run `claude /login` yourself, then press Start",
        },
        501,
      );
    }
    const bin = launcher.binFor("claude-code");
    if (!bin) {
      return c.json({ error: "claude-code is not installed (no claude on PATH)" }, 400);
    }
    // The login must run against the SAME isolated home the launches use. On
    // macOS the CLI keys its keychain entry to the config directory, so a
    // plain `claude /login` signs the user's terminal in and leaves every
    // launch exactly as signed out as before — a button that "works" forever.
    const home = launcher.claudeConfigHome();
    try {
      // A first sign-in can predate the first launch; the CLI needs the
      // directory to exist before it can write a login into it.
      mkdirSync(home, { recursive: true });
      openClaudeLogin(bin, home);
    } catch (err) {
      return c.json(
        { error: `could not open Terminal: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
    // A second press replaces the watch rather than stacking one: the user is
    // signing in once, in one terminal, and the fresh window is the one to wait
    // on.
    watching?.();
    watching = watchForClaudeSignIn(launcher, claudeSignInFiles(home));
    return c.json({ opened: true, watching: true, watchMs: SIGNIN_WATCH_MS });
  });
}

/** How often the sign-in watch looks. A login is minutes of typing, not ms. */
const SIGNIN_POLL_MS = 2_000;

/**
 * How long it keeps looking before giving the terminal up as abandoned.
 *
 * Long enough for an OAuth round trip through a browser and a paste-back;
 * short enough that a window the user closed does not leave a timer that
 * relaunches their agent an hour later, out of nowhere.
 */
const SIGNIN_WATCH_MS = 5 * 60 * 1000;

/**
 * The files a finished `claude /login` writes.
 *
 * The isolated home's pair first — that terminal runs with CLAUDE_CONFIG_DIR
 * set there, and its `.claude.json` account record is rewritten on every
 * login, including when the token itself went to the macOS keychain and no
 * credentials file exists at all. The user's own pair is still watched too:
 * someone who closes the opened terminal and runs a plain `claude /login`
 * instead has file-backed logins propagated into the launch by prepare's
 * credential copy, and their landing should relaunch the agent all the same.
 */
function claudeSignInFiles(home: string): string[] {
  return [
    join(home, ".credentials.json"),
    join(home, ".claude.json"),
    join(homedir(), ".claude", ".credentials.json"),
    join(homedir(), ".claude.json"),
  ];
}

/**
 * The AppleScript that puts `claude /login` in front of the user — pointed at
 * the launch's isolated home, because that is the only place a login is worth
 * anything to the agent (see the sign-in route).
 *
 * Two levels of quoting, both of which have to survive a path with a space in
 * it — `/Users/Ada Byron/.local/bin/claude` is an ordinary install: the shell
 * inside `do script`, and the AppleScript string literal around that. Pure and
 * exported so both are actually tested rather than eyeballed.
 */
export function claudeLoginScript(bin: string, configDir: string): string {
  const shell = `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ${shellQuote(bin)} /login`;
  const applescript = shell.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `tell application "Terminal"\nactivate\ndo script "${applescript}"\nend tell`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Runs that script. Detached: the terminal outlives the request that opened it. */
function openClaudeLogin(bin: string, configDir: string): void {
  const child = spawn("osascript", ["-e", claudeLoginScript(bin, configDir)], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  // osascript failing is asynchronous and there is nobody left to tell; the
  // watch below simply times out, which is the same outcome as a user who
  // closed the window.
  child.on("error", () => {});
}

/** What the watch needs of the launcher. Stated so a test can stand in for it. */
type SignInLauncher = {
  chatBusy(): boolean;
  lastModelFor(id: string): string | null;
  start(id: string, model?: string): Promise<unknown>;
};

/**
 * Watches for a login landing, and starts the agent when one does.
 *
 * Polls mtimes rather than fs.watch: the two paths may not exist yet — that is
 * the whole point of a first sign-in — and watching a directory for a file that
 * arrives, on two platforms' worth of atomic-rename behaviour, is more moving
 * parts than looking twice a second at two numbers.
 *
 * Returns a cancel. The timer is unref'd, so a watch nobody cancels cannot hold
 * the process open at shutdown.
 */
export function watchForClaudeSignIn(
  launcher: SignInLauncher,
  files: string[],
  opts: { pollMs?: number; windowMs?: number } = {},
): () => void {
  const before = files.map(mtimeOrNull);
  const deadline = Date.now() + (opts.windowMs ?? SIGNIN_WATCH_MS);
  const timer = setInterval(() => {
    const landed = files.some((file, i) => mtimeOrNull(file) !== before[i]);
    if (!landed && Date.now() < deadline) return;
    cancel();
    if (!landed) return;
    // The user may have pressed Start themselves while the terminal was open.
    // Checked here and enforced by the launcher, which refuses a second chat
    // launch outright — this only keeps the refusal out of the logs.
    if (launcher.chatBusy()) return;
    const model = launcher.lastModelFor("claude-code");
    void Promise.resolve(launcher.start("claude-code", model ?? undefined)).catch(() => {
      // A relaunch that will not start — the CLI moved, another one is already
      // running — is not worth an unhandled rejection. Start is still there.
    });
  }, opts.pollMs ?? SIGNIN_POLL_MS);
  timer.unref?.();
  let done = false;
  function cancel(): void {
    if (done) return;
    done = true;
    clearInterval(timer);
  }
  return cancel;
}

function mtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { MailService } from "../mail/service.js";
import type { AccountCredentials } from "../provider/types.js";
import { passwordCredentials } from "../provider/types.js";

/** Highest `limit` any list endpoint will accept. */
export const MAX_LIMIT = 200;

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
const CORS_METHODS = "GET, POST, DELETE, OPTIONS";
const CORS_HEADERS = "authorization, content-type";
const CORS_MAX_AGE = "600";

/**
 * Origin gate for the *authenticated* API. Loopback always passes, so the
 * self-hosted UI needs no configuration. Everything else must be an exact
 * origin match from the allowlist. Requests with no Origin (curl, MCP
 * clients, stdio) pass, exactly as before.
 *
 * NOT used by /api/local-bootstrap: that route hands out the bearer token
 * and must stay loopback-only via isAllowedOrigin.
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
 * Allow-Credentials is deliberately never sent: mailmux authenticates by
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
  if (raw === undefined || raw === "") return 50;
  if (!/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) return null;
  return limit;
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

  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "mailmux", version: "0.1.0" }),
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
    if (!account || account === "all") {
      return c.json({ error: "account is required" }, 400);
    }
    try {
      return c.json({ folders: await mail.listFolders(account) });
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
    }>();
    try {
      const result = await mail.sendMessage(body.account, {
        to: body.to,
        subject: body.subject,
        text: body.text,
        html: body.html,
        cc: body.cc,
        bcc: body.bcc,
        inReplyTo: body.inReplyTo,
        references: body.references,
      });
      return c.json({ result }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  return app;
}

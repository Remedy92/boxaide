import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { MailService } from "../mail/service.js";
import type { AccountCredentials } from "../provider/types.js";

/** Highest `limit` any list endpoint will accept. */
export const MAX_LIMIT = 200;

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
export function authFailure(c: Context, expected: string): Response | null {
  if (!isAllowedOrigin(c.req.header("origin"))) {
    return c.json({ error: "forbidden origin" }, 403);
  }
  const header = c.req.header("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!tokensMatch(bearer, expected)) {
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

export function createApi(mail: MailService, bearerToken: string): Hono {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const failure = authFailure(c, bearerToken);
    if (failure) return failure;
    await next();
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
    const body = await c.req.json<{
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
    }>();
    const creds: AccountCredentials = {
      imapHost: body.imapHost,
      imapPort: body.imapPort ?? 993,
      imapSecure: body.imapSecure ?? true,
      smtpHost: body.smtpHost,
      smtpPort: body.smtpPort ?? 465,
      smtpSecure: body.smtpSecure ?? true,
      username: body.username,
      password: body.password,
    };
    try {
      const account = await mail.connectAccount({
        alias: body.alias,
        email: body.email,
        creds,
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
    const body = await c.req.json<AccountCredentials>();
    const result = await mail.testCredentials(body);
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

import { Hono } from "hono";
import type { MailService } from "../mail/service.js";
import type { AccountCredentials } from "../provider/types.js";

export type ApiEnv = {
  Variables: {
    mail: MailService;
    token: string;
  };
};

function authMiddleware(expected: string) {
  return async (
    c: {
      req: { header: (n: string) => string | undefined };
      json: (b: unknown, s?: number) => Response;
      set: (k: "mail" | "token", v: unknown) => void;
      get: (k: "mail" | "token") => unknown;
    },
    next: () => Promise<void>,
  ) => {
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const query = (c as unknown as { req: { query: (k: string) => string | undefined } })
      .req.query?.("token");
    const token = bearer || query || "";
    if (token !== expected) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

export function createApi(mail: MailService, bearerToken: string): Hono {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const q = c.req.query("token") ?? "";
    if (bearer !== bearerToken && q !== bearerToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
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
    const limit = Number(c.req.query("limit") ?? 50);
    const folder = c.req.query("folder") ?? undefined;
    const unreadOnly = c.req.query("unread") === "1";
    try {
      const messages = await mail.listMessages(account, {
        limit,
        folder,
        unreadOnly,
      });
      return c.json({ messages });
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
    const limit = Number(c.req.query("limit") ?? 50);
    if (!query) return c.json({ error: "q is required" }, 400);
    try {
      const messages = await mail.searchMessages(account, { query, limit });
      return c.json({ messages });
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

  app.post("/api/messages/send", async (c) => {
    const body = await c.req.json<{
      account: string;
      to: string;
      subject: string;
      text: string;
      html?: string;
      cc?: string;
      bcc?: string;
    }>();
    try {
      const result = await mail.sendMessage(body.account, {
        to: body.to,
        subject: body.subject,
        text: body.text,
        html: body.html,
        cc: body.cc,
        bcc: body.bcc,
      });
      return c.json({ result }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  // silence unused
  void authMiddleware;

  return app;
}

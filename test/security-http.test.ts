import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import {
  createRuntime,
  isLocalHostHeader,
  isLoopbackBindAddress,
  isAllowedOrigin,
  isApiOriginAllowed,
  parseAllowedOrigins,
} from "../src/app.js";
import type { Runtime } from "../src/app.js";
import { parseConnectCredentials } from "../src/api/routes.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "test-token-abcdefghijklmnop";

function makeRuntime(allowedOrigins: string[] = []): Runtime {
  return createRuntime({
    dataDir: ":memory:",
    masterKey: randomBytes(32),
    bearerToken: TOKEN,
    host: "127.0.0.1",
    port: 0,
    fixtureMode: true,
    allowedOrigins,
    store: new Store(randomBytes(32), ":memory:"),
    provider: new FixtureProvider(),
  });
}

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

describe("parseConnectCredentials", () => {
  it("maps flat username/password to password auth", () => {
    const parsed = parseConnectCredentials({
      imapHost: "imap.gmail.com",
      smtpHost: "smtp.gmail.com",
      username: "u@g.com",
      password: "app-pass",
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.creds.auth).toEqual({
      kind: "password",
      user: "u@g.com",
      pass: "app-pass",
    });
  });

  it("accepts an explicitly shaped password auth object", () => {
    const parsed = parseConnectCredentials({
      imapHost: "imap.gmail.com",
      smtpHost: "smtp.gmail.com",
      auth: { kind: "password", user: "u@g.com", pass: "app-pass" },
    });
    expect(parsed.ok && parsed.creds.auth).toEqual({
      kind: "password",
      user: "u@g.com",
      pass: "app-pass",
    });
  });

  it("refuses xoauth2: no refresh path exists, so the account would expire", () => {
    const parsed = parseConnectCredentials({
      imapHost: "outlook.office365.com",
      smtpHost: "smtp.office365.com",
      auth: {
        kind: "xoauth2",
        user: "u@outlook.com",
        accessToken: "tok",
      },
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/xoauth2 is not accepted yet/);
  });

  it("rejects incomplete bodies", () => {
    expect(
      parseConnectCredentials({
        imapHost: "imap.gmail.com",
        smtpHost: "smtp.gmail.com",
        username: "u@g.com",
      }).ok,
    ).toBe(false);
    expect(
      parseConnectCredentials({
        imapHost: "",
        smtpHost: "smtp.gmail.com",
        username: "u@g.com",
        password: "p",
      }).ok,
    ).toBe(false);
  });
});

describe("POST /api/accounts rejects xoauth2 over REST", () => {
  it("answers 400 and stores nothing", async () => {
    const rt = makeRuntime();
    try {
      const res = await rt.app.request("/api/accounts", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          alias: "ms",
          email: "u@outlook.com",
          imapHost: "outlook.office365.com",
          smtpHost: "smtp.office365.com",
          auth: { kind: "xoauth2", user: "u@outlook.com", accessToken: "tok" },
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/xoauth2 is not accepted yet/);
      expect(rt.store.listAccounts()).toEqual([]);
    } finally {
      rt.store.close();
    }
  });
});

describe("isLocalHostHeader (P0: suffix-matched Host bypass)", () => {
  it("rejects attacker domains that merely start with a loopback name", () => {
    for (const host of [
      "localhost.evil.com",
      "localhost.attacker.io",
      "127.0.0.1.evil.com",
      "evil.com",
      "evil.com:8787",
      "127.0.0.1.evil.com:8787",
      "localhost.evil.com:8787",
      "notlocalhost",
      "",
    ]) {
      expect(isLocalHostHeader(host), `host: ${host}`).toBe(false);
    }
    expect(isLocalHostHeader(undefined)).toBe(false);
  });

  it("accepts the loopback interface with and without a port", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.1:8787",
      "localhost",
      "localhost:8787",
      "LOCALHOST:8787",
      "[::1]",
      "[::1]:8787",
      "::1",
    ]) {
      expect(isLocalHostHeader(host), `host: ${host}`).toBe(true);
    }
  });
});

describe("isAllowedOrigin (browser CSRF guard)", () => {
  it("passes requests with no Origin and loopback origins", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8787")).toBe(true);
    expect(isAllowedOrigin("http://localhost:8787")).toBe(true);
  });

  it("rejects a remote or unparsable Origin", () => {
    expect(isAllowedOrigin("http://localhost.evil.com")).toBe(false);
    expect(isAllowedOrigin("https://evil.com")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });
});

describe("isLoopbackBindAddress", () => {
  it("accepts every form of the loopback interface", () => {
    for (const host of ["127.0.0.1", "127.0.0.53", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackBindAddress(host)).toBe(true);
    }
  });

  it("rejects every address that answers off-machine", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "*", ""]) {
      expect(isLoopbackBindAddress(host)).toBe(false);
    }
    expect(isLoopbackBindAddress(undefined)).toBe(false);
  });

  it("rejects strings that look like 127/8 but are not addresses", () => {
    for (const host of [
      "127.999.999.999",
      "127.0.0.256",
      "127.0.0",
      "127.0.0.1.2",
      "127.0.0.x",
      "127.0.0.",
      "127.0.0.1.evil.com",
    ]) {
      expect(isLoopbackBindAddress(host)).toBe(false);
    }
  });
});

describe("HTTP security surface (shipped app)", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = makeRuntime();
  });

  afterEach(() => {
    runtime.store.close();
  });

  it("does not leak the bearer token to a spoofed Host header", async () => {
    const res = await runtime.app.request("/api/local-bootstrap", {
      headers: { Host: "localhost.evil.com" },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({ error: "localhost only" });
  });

  it("does not leak the bearer token to a remote Origin", async () => {
    const res = await runtime.app.request("/api/local-bootstrap", {
      headers: { Origin: "https://evil.com" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("hands the token to a genuine loopback request", async () => {
    const res = await runtime.app.request("/api/local-bootstrap", {
      headers: { Host: "127.0.0.1:8787" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe(TOKEN);
  });

  it("withholds the token entirely when the bind address is not loopback", async () => {
    const open = createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: TOKEN,
      host: "0.0.0.0",
      port: 0,
      fixtureMode: true,
      allowedOrigins: [],
      store: new Store(randomBytes(32), ":memory:"),
      provider: new FixtureProvider(),
    });
    try {
      // Both browser guards pass here: a remote client picks its own Host and
      // sends no Origin. The bind address is what stops it.
      const res = await open.app.request("/api/local-bootstrap", {
        headers: { Host: "localhost:8787" },
      });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(TOKEN);
    } finally {
      open.store.close();
    }
  });

  it("rejects ?token= auth and accepts the same token in the header", async () => {
    const query = await runtime.app.request(`/api/accounts?token=${TOKEN}`);
    expect(query.status).toBe(401);
    expect(await query.json()).toEqual({ error: "unauthorized" });

    const header = await runtime.app.request("/api/accounts", {
      headers: authHeaders,
    });
    expect(header.status).toBe(200);
    expect(await header.json()).toEqual({ accounts: [] });
  });

  it("rejects a wrong token and a bare (non-Bearer) token", async () => {
    const wrong = await runtime.app.request("/api/accounts", {
      headers: { Authorization: `Bearer ${TOKEN}x` },
    });
    expect(wrong.status).toBe(401);
    const bare = await runtime.app.request("/api/accounts", {
      headers: { Authorization: TOKEN },
    });
    expect(bare.status).toBe(401);
  });

  it("gates the agent-platform routes behind the same token", async () => {
    // One representative read per module. Registered inside createApi, so the
    // /api/* auth middleware must cover them — a regression here exposes CRM
    // data and the outreach approval surface to anything on localhost.
    const routes = [
      "/api/crm/contacts",
      "/api/automations",
      "/api/outreach/outbox",
      "/api/outreach/badge",
    ];
    for (const route of routes) {
      const anon = await runtime.app.request(route);
      expect(anon.status, route).toBe(401);
      const authed = await runtime.app.request(route, {
        headers: authHeaders,
      });
      expect(authed.status, route).toBe(200);
    }
  });
});

const VERCEL = "https://boxaide.vercel.app";

describe("parseAllowedOrigins (BOXAIDE_ALLOWED_ORIGINS)", () => {
  it("defaults closed on an unset or empty value", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins("   ")).toEqual([]);
    expect(parseAllowedOrigins(",, ,")).toEqual([]);
  });

  it("refuses the wildcard outright", () => {
    expect(parseAllowedOrigins("*")).toEqual([]);
    expect(parseAllowedOrigins(` * , ${VERCEL} `)).toEqual([VERCEL]);
  });

  it("drops http and unparsable entries", () => {
    expect(parseAllowedOrigins("http://boxaide.vercel.app")).toEqual([]);
    expect(parseAllowedOrigins("not a url")).toEqual([]);
    expect(parseAllowedOrigins("boxaide.vercel.app")).toEqual([]);
  });

  it("trims, lowercases, and reduces each entry to its origin", () => {
    expect(parseAllowedOrigins("  https://A.App/x?y#z  ")).toEqual([
      "https://a.app",
    ]);
    expect(parseAllowedOrigins("https://a.app:8443")).toEqual([
      "https://a.app:8443",
    ]);
    expect(parseAllowedOrigins(`${VERCEL},https://mail.example.com`)).toEqual([
      VERCEL,
      "https://mail.example.com",
    ]);
  });
});

describe("isApiOriginAllowed (allowlist gate)", () => {
  it("passes no-Origin callers and loopback with an empty allowlist", () => {
    expect(isApiOriginAllowed(undefined, [])).toBe(true);
    expect(isApiOriginAllowed("", [])).toBe(true);
    expect(isApiOriginAllowed("http://127.0.0.1:8787", [])).toBe(true);
    expect(isApiOriginAllowed("http://localhost:8787", [])).toBe(true);
  });

  it("rejects a remote origin when the allowlist is empty", () => {
    expect(isApiOriginAllowed(VERCEL, [])).toBe(false);
    expect(isApiOriginAllowed("https://evil.com", [])).toBe(false);
  });

  it("passes an exact allowlist match and rejects near misses", () => {
    const allowed = [VERCEL];
    expect(isApiOriginAllowed(VERCEL, allowed)).toBe(true);
    expect(isApiOriginAllowed("https://boxaide.vercel.app.evil.com", allowed)).toBe(false);
    expect(isApiOriginAllowed("http://boxaide.vercel.app", allowed)).toBe(false);
    expect(isApiOriginAllowed("https://boxaide.vercel.app:8443", allowed)).toBe(false);
    expect(isApiOriginAllowed("https://evil.com", allowed)).toBe(false);
    expect(isApiOriginAllowed("not a url", allowed)).toBe(false);
  });
});

describe("CORS allowlist over HTTP", () => {
  let closed: Runtime;
  let open: Runtime;

  beforeEach(() => {
    closed = makeRuntime();
    open = makeRuntime([VERCEL]);
  });

  afterEach(() => {
    closed.store.close();
    open.store.close();
  });

  it("default is closed: a remote origin is still 403 with no env var", async () => {
    const res = await closed.app.request("/api/accounts", {
      headers: { ...authHeaders, Origin: VERCEL },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden origin" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("default is closed: a preflight from a remote origin is 403", async () => {
    const res = await closed.app.request("/api/accounts", {
      method: "OPTIONS",
      headers: {
        Origin: VERCEL,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a wildcard in the env string opens nothing", async () => {
    const wild = makeRuntime(parseAllowedOrigins("*"));
    try {
      const res = await wild.app.request("/api/accounts", {
        headers: { ...authHeaders, Origin: VERCEL },
      });
      expect(res.status).toBe(403);
    } finally {
      wild.store.close();
    }
  });

  it("answers a preflight for an allowlisted origin without any token", async () => {
    const res = await open.app.request("/api/accounts", {
      method: "OPTIONS",
      headers: {
        Origin: VERCEL,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(VERCEL);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
    // The UI edits automations and campaigns with PATCH; a preflight that
    // omits it locks an allowlisted hosted origin out of those routes.
    expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "content-type",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("answers a PATCH preflight for the automation route", async () => {
    const res = await open.app.request("/api/automations/some-id", {
      method: "OPTIONS",
      headers: {
        Origin: VERCEL,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(VERCEL);
    expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
  });

  it("rejects a preflight from a non-allowlisted origin", async () => {
    const res = await open.app.request("/api/accounts", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
    expect(await res.text()).not.toContain("accounts");
  });

  it("serves a real request from an allowlisted origin and echoes it back", async () => {
    const res = await open.app.request("/api/accounts", {
      headers: { ...authHeaders, Origin: VERCEL },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
    expect(res.headers.get("access-control-allow-origin")).toBe(VERCEL);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("still rejects a non-allowlisted origin when one is allowlisted", async () => {
    const res = await open.app.request("/api/accounts", {
      headers: { ...authHeaders, Origin: "https://evil.com" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("an allowlisted origin still needs the bearer token", async () => {
    const none = await open.app.request("/api/accounts", {
      headers: { Origin: VERCEL },
    });
    expect(none.status).toBe(401);
    expect(none.headers.get("vary")).toBe("Origin");

    const wrong = await open.app.request("/api/accounts", {
      headers: { Origin: VERCEL, Authorization: `Bearer ${TOKEN}x` },
    });
    expect(wrong.status).toBe(401);
  });

  it("does not widen /api/local-bootstrap to the allowlisted origin", async () => {
    const res = await open.app.request("/api/local-bootstrap", {
      headers: { Origin: VERCEL, Host: "127.0.0.1:8787" },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({ error: "forbidden origin" });
  });

  it("covers /mcp with the same gate", async () => {
    const pre = await open.app.request("/mcp", {
      method: "OPTIONS",
      headers: { Origin: VERCEL, "Access-Control-Request-Method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(VERCEL);

    const ok = await open.app.request("/mcp", {
      method: "POST",
      headers: { ...authHeaders, Origin: VERCEL },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(VERCEL);

    const denied = await open.app.request("/mcp", {
      method: "POST",
      headers: { ...authHeaders, Origin: "https://evil.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(denied.status).toBe(403);
  });

  it("echoes the parsed origin, never the raw Origin header", async () => {
    // The WHATWG parser reads a backslash as a slash, so this string parses to
    // https://good.example and passes the allowlist. Echoing it verbatim would
    // hand the response to https://good.example\.evil.com.
    for (const raw of [`${VERCEL}\\.evil.com`, `${VERCEL}/`, `${VERCEL}/x?y`]) {
      const res = await open.app.request("/api/accounts", {
        headers: { ...authHeaders, Origin: raw },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(VERCEL);
    }
  });

  it("never answers a preflight with the raw Origin header either", async () => {
    const res = await open.app.request("/api/accounts", {
      method: "OPTIONS",
      headers: {
        Origin: `${VERCEL}\\.evil.com`,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(VERCEL);
  });

  it("marks the local-bootstrap token response uncacheable", async () => {
    const res = await open.app.request("/api/local-bootstrap", {
      headers: { Host: "127.0.0.1:8787" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("Origin");
    // And it still hands out nothing to a browser: no CORS header at all.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("covers /health so the UI can tell 'down' from 'bad token'", async () => {
    const pre = await open.app.request("/health", {
      method: "OPTIONS",
      headers: { Origin: VERCEL, "Access-Control-Request-Method": "GET" },
    });
    expect(pre.status).toBe(204);

    const ok = await open.app.request("/health", {
      headers: { Origin: VERCEL },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(VERCEL);

    const denied = await open.app.request("/health", {
      headers: { Origin: "https://evil.com" },
    });
    expect(denied.status).toBe(403);

    // curl and smoke checks send no Origin and must be unchanged.
    const bare = await open.app.request("/health");
    expect(bare.status).toBe(200);
    expect(bare.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("limit validation on list endpoints", () => {
  let runtime: Runtime;

  beforeEach(async () => {
    runtime = makeRuntime();
    const res = await runtime.app.request("/api/accounts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        alias: "personal",
        email: "you@personal.test",
        username: "you@personal.test",
        password: "ok",
        imapHost: "fixture",
        smtpHost: "fixture",
      }),
    });
    expect(res.status).toBe(201);
  });

  afterEach(() => {
    runtime.store.close();
  });

  async function listWith(limit: string): Promise<Response> {
    return runtime.app.request(
      `/api/messages?account=all&limit=${encodeURIComponent(limit)}`,
      { headers: authHeaders },
    );
  }

  it("rejects a non-numeric limit with 400, not an empty list", async () => {
    const res = await listWith("abc");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/limit must be an integer/);
    expect(body.messages).toBeUndefined();
  });

  it("rejects limit=0 and a negative limit", async () => {
    expect((await listWith("0")).status).toBe(400);
    expect((await listWith("-5")).status).toBe(400);
  });

  it("rejects a limit above the clamp ceiling", async () => {
    expect((await listWith("201")).status).toBe(400);
    expect((await listWith("999999")).status).toBe(400);
  });

  it("accepts the boundary values 1 and 200", async () => {
    expect((await listWith("1")).status).toBe(200);
    expect((await listWith("200")).status).toBe(200);
  });

  it("applies the same rule to the search endpoint", async () => {
    const bad = await runtime.app.request(
      "/api/messages/search?account=all&q=welcome&limit=abc",
      { headers: authHeaders },
    );
    expect(bad.status).toBe(400);
    const ok = await runtime.app.request(
      "/api/messages/search?account=all&q=welcome&limit=5",
      { headers: authHeaders },
    );
    expect(ok.status).toBe(200);
  });
});

describe("suppression override on POST /api/messages/send", () => {
  let runtime: Runtime;
  let accountId: string;

  const BLOCKED = "blocked@example.test";

  async function send(extra: Record<string, unknown>): Promise<Response> {
    return runtime.app.request("/api/messages/send", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        account: "all",
        to: BLOCKED,
        subject: "s",
        text: "t",
        ...extra,
      }),
    });
  }

  beforeEach(async () => {
    runtime = makeRuntime();
    const res = await runtime.app.request("/api/accounts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        alias: "personal",
        email: "you@personal.test",
        username: "you@personal.test",
        password: "ok",
        imapHost: "fixture",
        smtpHost: "fixture",
      }),
    });
    expect(res.status).toBe(201);
    const account = (await res.json()) as { account: { id: string } };
    accountId = account.account.id;
    runtime.platform.outreachStore.addSuppression(BLOCKED, "manual");
  });

  afterEach(() => {
    runtime.store.close();
  });

  it("blocks a send to a suppressed recipient with no flag", async () => {
    const res = await send({ account: accountId });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/recipient suppressed/);
  });

  it("lets a human through with overrideSuppression: true", async () => {
    const res = await send({ account: accountId, overrideSuppression: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toHaveProperty("result");
  });

  // Anything that is not the boolean true is not consent: a string "false", a
  // truthy string, or a 1 must all still hit the guard.
  it.each([["false"], ["true"], [1], [{}]])(
    "treats %o as no override",
    async (value) => {
      const res = await send({
        account: accountId,
        overrideSuppression: value,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/recipient suppressed/);
    },
  );

  // The guard must see every address nodemailer would deliver to. These are
  // the forms a comma-only split misses; each smuggles BLOCKED past a naive
  // parser while nodemailer still delivers to it.
  it.each([
    ["semicolon-separated list", `ok@x.test; ${BLOCKED}`],
    ["group syntax", `team: ok@x.test, ${BLOCKED};`],
    ["display name with comma", `"Doe, Jane" <ok@x.test>, ${BLOCKED}`],
  ])("blocks a suppressed recipient hidden in a %s", async (_label, to) => {
    const res = await send({ account: accountId, to });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/recipient suppressed/);
  });

  it("blocks a suppressed cc even when to is clean", async () => {
    const res = await send({
      account: accountId,
      to: "ok@x.test",
      cc: `list: ${BLOCKED};`,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/recipient suppressed/);
  });

  // The guard canonicalizes with canonicalEmail, so the unicode spelling of an
  // IDN domain resolves to the punycode key nodemailer would deliver to. The
  // suppression uses the punycode form directly, so this holds whether or not
  // the store canonicalizes on its own side.
  it("blocks a unicode IDN address suppressed in its punycode form", async () => {
    runtime.platform.outreachStore.addSuppression(
      "user@xn--mnchen-3ya.de",
      "manual",
    );
    const res = await send({ account: accountId, to: "user@münchen.de" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/recipient suppressed/);
  });
});

// A non-string recipient used to sail past the guard: addressparser returns
// address "" for it, so the guard saw an empty list while nodemailer still
// delivered. sendMessage now fails closed before parsing.
describe("non-string recipients on POST /api/messages/send", () => {
  let runtime: Runtime;
  let provider: FixtureProvider;
  let accountId: string;

  async function send(body: Record<string, unknown>): Promise<Response> {
    return runtime.app.request("/api/messages/send", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ subject: "s", text: "t", ...body }),
    });
  }

  beforeEach(async () => {
    provider = new FixtureProvider();
    runtime = createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: TOKEN,
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      allowedOrigins: [],
      store: new Store(randomBytes(32), ":memory:"),
      provider,
    });
    const res = await runtime.app.request("/api/accounts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        alias: "personal",
        email: "you@personal.test",
        username: "you@personal.test",
        password: "ok",
        imapHost: "fixture",
        smtpHost: "fixture",
      }),
    });
    expect(res.status).toBe(201);
    accountId = ((await res.json()) as { account: { id: string } }).account.id;
    provider.clear();
  });

  afterEach(() => {
    runtime.store.close();
  });

  it("rejects an object `to` and delivers nothing", async () => {
    const res = await send({
      account: accountId,
      to: { name: "Blocked", address: "blocked@example.test" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /invalid recipients: to\/cc\/bcc must be strings/,
    );
    expect(provider.getSent()).toHaveLength(0);
  });

  it("rejects an object `cc` even with a valid string `to`", async () => {
    const res = await send({
      account: accountId,
      to: "ok@x.test",
      cc: { name: "Blocked", address: "blocked@example.test" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /invalid recipients: to\/cc\/bcc must be strings/,
    );
    expect(provider.getSent()).toHaveLength(0);
  });

  it("rejects an array `bcc`", async () => {
    const res = await send({
      account: accountId,
      to: "ok@x.test",
      bcc: ["a@x.test"],
    });
    expect(res.status).toBe(400);
    expect(provider.getSent()).toHaveLength(0);
  });

  it("still sends when to/cc/bcc are strings", async () => {
    const res = await send({
      account: accountId,
      to: "ok@x.test",
      cc: "cc@x.test",
    });
    expect(res.status).toBe(201);
    expect(provider.getSent()).toHaveLength(1);
  });
});

describe("security response headers", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = makeRuntime();
  });

  afterEach(() => {
    runtime.store.close();
  });

  // Every one of these closes a class the token and the origin allowlist do
  // not touch. A regression here is silent in the UI, so it is asserted.
  const expected: ReadonlyArray<[string, string]> = [
    ["x-frame-options", "DENY"],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "no-referrer"],
    ["cross-origin-opener-policy", "same-origin"],
  ];

  it.each(expected)("sets %s on the UI response", async (header, value) => {
    const res = await runtime.app.request("/");
    expect(res.headers.get(header)).toBe(value);
  });

  it.each(expected)("sets %s on an API response", async (header, value) => {
    const res = await runtime.app.request("/api/accounts", {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(header)).toBe(value);
  });

  it("sets the headers even on an unauthorized response", async () => {
    const res = await runtime.app.request("/api/accounts");
    expect(res.status).toBe(401);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("forbids framing and inline base tags in the CSP", async () => {
    const csp = (await runtime.app.request("/")).headers.get(
      "content-security-policy",
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("allows only loopback and https in connect-src", async () => {
    const csp =
      (await runtime.app.request("/")).headers.get(
        "content-security-policy",
      ) ?? "";
    const connectSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"));
    // The Server URL is user-configurable, so 'self' alone breaks the app on
    // any port but the default. Plain http: to a remote host stays blocked.
    expect(connectSrc).toBe(
      "connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:* https:",
    );
    expect(connectSrc).not.toContain("http://*");
    expect(csp).not.toContain("connect-src *");
  });

  it("never loosens script-src to allow an arbitrary external origin", async () => {
    const csp =
      (await runtime.app.request("/")).headers.get(
        "content-security-policy",
      ) ?? "";
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe("script-src 'self' 'unsafe-inline'");
  });
});

describe("web root resolution", () => {
  // The UI is a build artifact. `/` must be honest in both states rather than
  // serving a stale page, so both are asserted directly.
  it("serves the export when one is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailmux-web-present-"));
    writeFileSync(join(dir, "index.html"), "<title>mailmux</title>");
    const runtime = createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: TOKEN,
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      store: new Store(randomBytes(32), ":memory:"),
      provider: new FixtureProvider(),
      webRoot: dir,
    });
    const res = await runtime.app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>mailmux</title>");
    runtime.store.close();
  });

  it("names the build command when no export exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailmux-web-absent-"));
    const runtime = createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: TOKEN,
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      store: new Store(randomBytes(32), ":memory:"),
      provider: new FixtureProvider(),
      webRoot: dir,
    });
    const res = await runtime.app.request("/");
    expect(res.status).toBe(500);
    // A user who hits this needs the command, not just the symptom.
    expect(await res.text()).toContain("npm run build");
    runtime.store.close();
  });
});

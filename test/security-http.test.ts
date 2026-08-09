import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { createRuntime, isLocalHostHeader, isAllowedOrigin } from "../src/app.js";
import type { Runtime } from "../src/app.js";

const TOKEN = "test-token-abcdefghijklmnop";

function makeRuntime(): Runtime {
  return createRuntime({
    dataDir: ":memory:",
    masterKey: randomBytes(32),
    bearerToken: TOKEN,
    host: "127.0.0.1",
    port: 0,
    fixtureMode: true,
    store: new Store(randomBytes(32), ":memory:"),
    provider: new FixtureProvider(),
  });
}

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

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

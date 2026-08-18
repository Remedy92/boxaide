/**
 * The agent boundary, tested where it is enforced.
 *
 * Boxaide launches agent CLIs and hands each one a credential. These tests are
 * the reason a CLI with no per-tool allowlist flag of its own can be launched
 * at all: the refusal comes from this server, so it holds whatever the client
 * was told it could do.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";
import { createPlatform, type Platform } from "../src/platform.js";
import { AgentChannel } from "../src/agent/channel.js";
import { ApprovalQueue, MAX_PENDING } from "../src/agent/approvals.js";
import type { AgentLauncher } from "../src/agent/launcher.js";
import {
  SCOPE_PROFILES,
  scopeAllows,
  scopeToolNames,
  type ScopeProfile,
} from "../src/mcp/scope.js";
import { ScopedTokens, secretsMatch } from "../src/mcp/scoped-tokens.js";
import { createRuntime } from "../src/app.js";

const baseCreds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "p@test.com", pass: "ok" },
};

type ToolResult = {
  result: { content: Array<{ text: string }>; isError?: boolean };
};

/** Every tool this server can offer, whatever the scope. */
function everyToolName(): string[] {
  return [...new Set(scopeToolNames("chat"))];
}

describe("agent scopes", () => {
  let store: Store;
  let mail: MailService;
  let platform: Platform;
  let channel: AgentChannel;
  let approvals: ApprovalQueue;

  beforeEach(async () => {
    store = new Store(randomBytes(32), ":memory:");
    mail = new MailService(store, new FixtureProvider());
    channel = new AgentChannel(store);
    platform = createPlatform({
      db: store.db,
      masterKey: randomBytes(32),
      mail,
      launcher: undefined as unknown as AgentLauncher,
    });
    approvals = new ApprovalQueue(store, { mail, platform, channel });
    await mail.connectAccount({
      alias: "personal",
      email: "p@test.com",
      creds: baseCreds,
    });
  });

  afterEach(() => {
    channel.close();
    store.close();
  });

  async function call(
    name: string,
    scope: ScopeProfile | null,
    args: Record<string, unknown> = {},
  ) {
    return (await handleMcpJsonRpc(
      mail,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      channel,
      platform,
      undefined,
      scope,
      approvals,
    )) as ToolResult;
  }

  async function listed(scope: ScopeProfile | null): Promise<string[]> {
    const res = (await handleMcpJsonRpc(
      mail,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      channel,
      platform,
      undefined,
      scope,
    )) as { result: { tools: Array<{ name: string }> } };
    return res.result.tools.map((t) => t.name);
  }

  it("lets every scope ask to send, and performs none of it", async () => {
    // The old rule was that these three tools did not exist for a launched
    // agent, which also meant an inbox agent could not answer an email. They
    // exist now; what changed is that calling one records a request instead of
    // reaching SMTP. A scheduled run may ask too — nobody is awake to answer
    // it, and the request is waiting in the morning.
    for (const scope of SCOPE_PROFILES) {
      for (const tool of ["message_send", "meeting_create", "meeting_cancel"]) {
        expect(scopeAllows(scope, tool)).toBe(true);
        expect(await listed(scope)).toContain(tool);
        const res = await call(tool, scope, {
          account: "personal",
          to: "x@test.com",
          subject: "s",
          text: "t",
        });
        expect(res.result.isError).toBeUndefined();
        const body = JSON.parse(res.result.content[0].text) as {
          queued: boolean;
          status: string;
        };
        expect(body.queued).toBe(true);
        // The model has to understand it was not throttled. A "try later"
        // reading is what produces a retry loop against a human.
        expect(body.status).toContain("approval");
        expect(body.status).toContain("Do not call it again");
      }
    }
    // Nine asks, nine cards, nothing sent.
    expect(approvals.pending()).toHaveLength(9);
    expect((await mail.listMessages("personal", { folder: "Sent" })).messages)
      .toHaveLength(0);
  });

  it("sends only what the user approved, and never what they declined", async () => {
    await call("message_send", "chat", {
      account: "personal",
      to: "yes@test.com",
      subject: "approved",
      text: "body",
    });
    await call("message_send", "chat", {
      account: "personal",
      to: "no@test.com",
      subject: "declined",
      text: "body",
    });
    const [first, second] = approvals.pending();
    // The card is built from the arguments that get replayed, so what the user
    // reads and what goes out cannot drift.
    expect(first.title).toContain("approved");
    expect(first.title).toContain("yes@test.com");

    expect((await approvals.decide(first.id, "approve")).state).toBe("approved");
    expect((await approvals.decide(second.id, "deny")).state).toBe("denied");
    expect(approvals.pending()).toHaveLength(0);

    const sent = (await mail.listMessages("personal", { folder: "Sent" })).messages;
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("approved");
  });

  it("answers a request once, however many windows are looking at it", async () => {
    await call("message_send", "chat", {
      account: "personal",
      to: "x@test.com",
      subject: "once",
      text: "body",
    });
    const [row] = approvals.pending();
    await approvals.decide(row.id, "approve");
    // The second window still had the card painted. Its click must change
    // nothing rather than send the same mail twice.
    await expect(approvals.decide(row.id, "approve")).rejects.toThrow(
      /already approved/,
    );
    expect((await mail.listMessages("personal", { folder: "Sent" })).messages)
      .toHaveLength(1);
  });

  it("stops a model that asks in a loop instead of filling the pane", async () => {
    for (let i = 0; i < MAX_PENDING; i++) {
      const res = await call("message_send", "chat", {
        account: "personal",
        to: `x${i}@test.com`,
        subject: `s${i}`,
        text: "t",
      });
      expect(res.result.isError).toBeUndefined();
    }
    const over = await call("message_send", "chat", {
      account: "personal",
      to: "one-too-many@test.com",
      subject: "s",
      text: "t",
    });
    expect(over.result.isError).toBe(true);
    expect(over.result.content[0].text).toContain("already waiting");
    expect(approvals.pending()).toHaveLength(MAX_PENDING);
  });

  it("still sends for an unscoped caller, so the boundary is the scope and not the tool", async () => {
    const res = await call("message_send", null, {
      account: "personal",
      to: "x@test.com",
      subject: "s",
      text: "t",
    });
    expect(res.result.isError).toBeUndefined();
  });

  it("refuses a tool outside the scope even when it was never listed", async () => {
    // The listing is a courtesy; a model that has seen a name once will call
    // it. Enforcement has to be on the call, and this is that test.
    expect(await listed("run")).not.toContain("chat_say");
    const res = await call("chat_say", "run", { text: "hello" });
    expect(res.result.isError).toBe(true);
  });

  it("keeps a driven session off the chat loop but leaves it its history", async () => {
    expect(scopeAllows("driven", "chat_await_message")).toBe(false);
    expect(scopeAllows("driven", "chat_say")).toBe(false);
    expect(scopeAllows("driven", "chat_history")).toBe(true);
    expect(scopeAllows("chat", "chat_await_message")).toBe(true);
  });

  it("gives a scheduled run no conversation and a read-only schedule", async () => {
    for (const tool of ["chat_await_message", "chat_say", "chat_history"]) {
      expect(scopeAllows("run", tool)).toBe(false);
    }
    expect(scopeAllows("run", "automations_list")).toBe(true);
    expect(scopeAllows("run", "automation_create")).toBe(false);
    expect(scopeAllows("chat", "automation_create")).toBe(true);
  });

  it("refuses by default: a tool no scope names is denied, not allowed", async () => {
    // The failure this guards against is a tool added to the server and
    // forgotten in scope.ts. Silence must mean no.
    expect(scopeAllows("chat", "some_future_tool")).toBe(false);
    const res = await call("some_future_tool", "chat");
    expect((res as unknown as { error?: { message: string } }).error?.message).toMatch(
      /Unknown tool/,
    );
  });

  it("lists exactly what it allows", async () => {
    for (const scope of SCOPE_PROFILES) {
      const names = await listed(scope);
      for (const tool of everyToolName()) {
        expect(names.includes(tool)).toBe(scopeAllows(scope, tool));
      }
    }
  });
});

describe("scoped tokens", () => {
  it("mints, resolves, and stops resolving once revoked", () => {
    const tokens = new ScopedTokens();
    const grant = tokens.mint("run", "run:abc");
    expect(tokens.resolve(grant.token)).toBe("run");
    grant.revoke();
    expect(tokens.resolve(grant.token)).toBeNull();
    // Idempotent: a launch can end more than one way.
    grant.revoke();
    expect(tokens.list()).toHaveLength(0);
  });

  it("does not resolve an empty or unknown token", () => {
    const tokens = new ScopedTokens();
    tokens.mint("chat", "chat:x");
    expect(tokens.resolve("")).toBeNull();
    expect(tokens.resolve("not-a-token")).toBeNull();
  });

  it("mints a distinct, unguessable token each time", () => {
    const tokens = new ScopedTokens();
    const seen = new Set(
      Array.from({ length: 50 }, () => tokens.mint("chat", "x").token),
    );
    expect(seen.size).toBe(50);
    for (const token of seen) expect(token.length).toBeGreaterThanOrEqual(40);
  });
});

describe("/mcp credentials", () => {
  const master = "master-token-abcdefghijklmnop";

  function runtime() {
    return createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: master,
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      allowedOrigins: [],
      store: new Store(randomBytes(32), ":memory:"),
      provider: new FixtureProvider(),
    });
  }

  async function toolsWith(app: { request: typeof fetch }, token: string) {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return res;
  }

  it("accepts a scoped token on /mcp and enforces its scope over HTTP", async () => {
    const rt = runtime();
    const grant = rt.scopedTokens.mint("run", "run:test");
    const res = await toolsWith(rt.app as never, grant.token);
    expect(res.status).toBe(200);
    const names = (await res.json()).result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(names).not.toContain("chat_say");
    expect(names).toContain("draft_create");
    // A run may ask. What it may not do is send, which the call below is.
    expect(names).toContain("message_send");

    const send = await rt.app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${grant.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "message_send",
          arguments: { account: "personal", to: "a@b.c", subject: "s", text: "t" },
        },
      }),
    });
    // Queued, not sent, and not refused either: over HTTP, on a run's token,
    // with nobody awake to answer it.
    const body = await send.json();
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text).queued).toBe(true);
    expect(rt.approvals.pending()).toHaveLength(1);

    rt.launcher.close();
    rt.channel.close();
    rt.store.close();
  });

  it("never treats an empty credential as the master bearer", () => {
    // An empty bearer.token — truncated write, restored backup, a touched file
    // — used to make "no Authorization header at all" the unrestricted caller
    // on /mcp, the one route that did not go through tokensMatch.
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("", "real-token")).toBe(false);
    expect(secretsMatch("real-token", "real-token")).toBe(true);
  });

  it("rejects a revoked token, and never accepts one anywhere but /mcp", async () => {
    const rt = runtime();
    const grant = rt.scopedTokens.mint("chat", "chat:test");
    const auth = { Authorization: `Bearer ${grant.token}` };

    // A launched agent has no business reading settings or starting another
    // agent. Before scopes it held the master bearer and could do both.
    expect((await rt.app.request("/api/agents", { headers: auth })).status).toBe(401);
    expect((await rt.app.request("/api/accounts", { headers: auth })).status).toBe(401);

    expect((await toolsWith(rt.app as never, grant.token)).status).toBe(200);
    grant.revoke();
    expect((await toolsWith(rt.app as never, grant.token)).status).toBe(401);

    rt.launcher.close();
    rt.channel.close();
    rt.store.close();
  });
});

/**
 * The undo for what a launched agent archived.
 *
 * The feature exists because "archiving is reversible" is only true if a
 * person can reverse it, so these tests are about exactly that: what is
 * written down, how it groups into one sweep, and what the counts say when
 * putting it back only half works.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { ArchiveLog, SWEEP_GAP_MS } from "../src/agent/archive-log.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";
import { createPlatform, type Platform } from "../src/platform.js";
import { createRuntime } from "../src/app.js";
import type { AgentLauncher } from "../src/agent/launcher.js";

const creds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "p@test.com", pass: "ok" },
};

describe("the archive log", () => {
  let store: Store;
  let mail: MailService;
  let log: ArchiveLog;
  let platform: Platform;
  let provider: FixtureProvider;

  beforeEach(async () => {
    store = new Store(randomBytes(32), ":memory:");
    provider = new FixtureProvider();
    mail = new MailService(store, provider);
    platform = createPlatform({
      db: store.db,
      masterKey: randomBytes(32),
      mail,
      launcher: undefined as unknown as AgentLauncher,
      store,
    });
    log = platform.archiveLog!;
    const account = await mail.connectAccount({
      alias: "personal",
      email: "p@test.com",
      creds,
    });
    provider.seedAccount(
      account.id,
      "p@test.com",
      ["Invoice 402", "Standup notes", "Renewal", "Newsletter"].map((subject) => ({
        subject,
        from: "sender@test.com",
      })),
    );
  });

  afterEach(() => store.close());

  /** One MCP call as a launched agent, which is the only caller that records. */
  const call = (name: string, args: Record<string, unknown>) =>
    handleMcpJsonRpc(
      mail,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      undefined,
      platform,
      undefined,
      "chat",
    );

  it("records what a launched agent archived, and nothing the user did", async () => {
    const inbox = await mail.listMessages("personal", { limit: 5 });
    await call("message_archive", {
      account: "personal",
      messageId: inbox.messages[0].id,
    });
    expect(log.sweeps()).toHaveLength(1);
    expect(log.sweeps()[0]).toMatchObject({ count: 1, undoable: 1 });

    // The same archive through the service, which is what the web UI reaches:
    // the user archived it on purpose and has the toast's own undo.
    await mail.archiveMessage("personal", inbox.messages[1].id);
    expect(log.sweeps()[0].count).toBe(1);
  });

  it("moves a whole sweep back in one call", async () => {
    const inbox = await mail.listMessages("personal", { limit: 5 });
    const ids = inbox.messages.slice(0, 3).map((m) => m.id);
    for (const id of ids) {
      await call("message_archive", { account: "personal", messageId: id });
    }
    const [sweep] = log.sweeps();
    expect(sweep.count).toBe(3);

    const before = await mail.listMessages("personal", { limit: 20 });
    expect(before.messages.map((m) => m.id)).not.toContain(ids[0]);

    expect(await log.undo(sweep.id)).toEqual({ restored: 3, failed: 0 });
    const after = await mail.listMessages("personal", { folder: "INBOX", limit: 20 });
    expect(after.messages).toHaveLength(before.messages.length + 3);
    // Spent: the sweep cannot be undone a second time.
    expect(log.sweeps()).toHaveLength(0);
  });

  it("keeps a message somebody moved by hand out of the counts", async () => {
    const inbox = await mail.listMessages("personal", { limit: 5 });
    const ids = inbox.messages.slice(0, 2).map((m) => m.id);
    for (const id of ids) {
      await call("message_archive", { account: "personal", messageId: id });
    }
    // Another client moved one on: the undo has nothing to put back for it,
    // and must not claim it did.
    const archived = await mail.listMessages("personal", {
      folder: "Archive",
      limit: 5,
    });
    await mail.moveMessage("personal", archived.messages[0].id, "Sent");

    const [sweep] = log.sweeps();
    const result = await log.undo(sweep.id);
    expect(result.restored).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("splits runs that are far apart, and keeps one run together", () => {
    const base = Date.parse("2026-08-20T09:00:00.000Z");
    const row = (offset: number, agent = "claude") => ({
      accountId: "acct",
      messageId: `acct:Archive:${offset}`,
      fromFolder: "INBOX",
      toFolder: "Archive",
      agent,
      chatId: "chat-1",
      now: base + offset,
    });
    log.record(row(0));
    log.record(row(1_000));
    log.record(row(SWEEP_GAP_MS + 5_000));
    // A different agent is a different sweep even back to back.
    log.record(row(SWEEP_GAP_MS + 6_000, "codex"));

    const sweeps = log.sweeps(base + SWEEP_GAP_MS + 10_000);
    expect(sweeps.map((s) => s.count)).toEqual([1, 1, 2]);
    expect(sweeps[0].agent).toBe("codex");
  });

  it("carries the sweeps on agent state, and undoes one over HTTP", async () => {
    // The pane reads sweeps off /api/agent/state for the same reason it reads
    // approvals there: a second poll would let the two disagree.
    const TOKEN = "test-token-abcdefghijklmnop";
    const rt = createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: TOKEN,
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      allowedOrigins: [],
      store: new Store(randomBytes(32), ":memory:"),
      provider: new FixtureProvider(),
    });
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    };
    const connected = await rt.app.request("/api/accounts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        alias: "personal",
        email: "you@personal.test",
        username: "you@personal.test",
        password: "ok",
        imapHost: "fixture",
        smtpHost: "fixture",
      }),
    });
    const account = (await connected.json()).account;

    const listed = await rt.app.request("/api/messages?account=personal", {
      headers,
    });
    const message = (await listed.json()).messages[0];
    const archived = await (
      await rt.app.request(
        `/api/messages/personal/${encodeURIComponent(message.id)}/archive`,
        { method: "POST", headers },
      )
    ).json();
    // Recorded the way the MCP dispatch records it, from the move's own answer.
    rt.platform.archiveLog!.record({
      accountId: account.id,
      messageId: archived.id,
      fromFolder: archived.fromFolder,
      toFolder: archived.toFolder,
      agent: "claude",
      chatId: null,
    });

    const state = await rt.app.request("/api/agent/state", { headers });
    const sweeps = (await state.json()).archiveSweeps;
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ count: 1, agent: "claude" });

    const undone = await rt.app.request(
      `/api/agent/archives/${sweeps[0].id}/undo`,
      { method: "POST", headers },
    );
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({
      restored: 1,
      failed: 0,
      sweeps: [],
    });
    // Back in the inbox it was filed from, which is the whole claim.
    const inbox = await rt.app.request("/api/messages?account=personal", {
      headers,
    });
    expect(
      (await inbox.json()).messages.map((m: { subject: string }) => m.subject),
    ).toContain(message.subject);

    // The gate is the bearer, like every other agent route.
    expect(
      (await rt.app.request("/api/agent/archives/1/undo", { method: "POST" }))
        .status,
    ).toBe(401);
    rt.store.close();
  });

  it("counts an archive it cannot reverse, and says so", () => {
    // No id: a server without UIDPLUS archived the message without naming
    // where it landed. The count is the truth about what happened; `undoable`
    // is the truth about what can be taken back.
    log.record({
      accountId: "acct",
      messageId: null,
      fromFolder: "INBOX",
      toFolder: "Archive",
      agent: "claude",
      chatId: null,
    });
    expect(log.sweeps()[0]).toMatchObject({ count: 1, undoable: 0 });
  });
});

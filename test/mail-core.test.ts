import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { encryptSecret, decryptSecret } from "../src/crypto/secrets.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";
import { createRuntime } from "../src/app.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Stands in for a built `web-next/`. Contents mirror the export's shell. */
const WEB_FIXTURE = mkdtempSync(join(tmpdir(), "mailmux-web-"));
writeFileSync(
  join(WEB_FIXTURE, "index.html"),
  "<!DOCTYPE html><html><head><title>mailmux</title></head><body></body></html>",
);

function makeService() {
  const masterKey = randomBytes(32);
  const store = new Store(masterKey, ":memory:");
  const provider = new FixtureProvider();
  const mail = new MailService(store, provider);
  return { masterKey, store, provider, mail };
}

const PERSONAL_PASS = "personal-app-password-fixture";

const baseCreds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "a@test.com", pass: "ok" },
};

describe("crypto secrets", () => {
  it("round-trips AES-GCM encryption via shipped functions", () => {
    const key = randomBytes(32);
    const enc = encryptSecret(key, "app-password-secret");
    expect(enc).not.toContain("app-password-secret");
    expect(decryptSecret(key, enc)).toBe("app-password-secret");
  });
});

describe("Store xoauth2 credential round-trip", () => {
  it("persists auth_kind and decrypts access tokens", () => {
    const masterKey = randomBytes(32);
    const store = new Store(masterKey, ":memory:");
    store.upsertAccount({
      id: "acct1",
      alias: "ms",
      email: "u@outlook.com",
      creds: {
        ...baseCreds,
        auth: {
          kind: "xoauth2",
          user: "u@outlook.com",
          accessToken: "ya29.secret-token",
        },
      },
    });
    const row = store.getAccount("ms");
    expect(row?.authKind).toBe("xoauth2");
    expect(row?.passwordEnc).not.toContain("ya29");
    expect(store.credentialsFor(row!).auth).toEqual({
      kind: "xoauth2",
      user: "u@outlook.com",
      accessToken: "ya29.secret-token",
    });
    store.close();
  });
});

describe("MailService connect/list/read/send (shipped path)", () => {
  let mail: MailService;
  let provider: FixtureProvider;
  let store: Store;

  beforeEach(() => {
    const s = makeService();
    mail = s.mail;
    provider = s.provider;
    store = s.store;
  });

  it("connects two accounts and lists unified inbox", async () => {
    const personal = await mail.connectAccount({
      alias: "personal",
      email: "you@personal.test",
      // Long and distinctive, because the encryption check below searches the
      // ciphertext for this string. A short one matches base64 by chance.
      creds: {
        ...baseCreds,
        auth: { kind: "password", user: "you@personal.test", pass: PERSONAL_PASS },
      },
    });
    const work = await mail.connectAccount({
      alias: "work",
      email: "you@work.test",
      creds: { ...baseCreds, auth: { kind: "password", user: "you@work.test", pass: "ok" } },
    });

    provider.seedAccount(personal.id, "you@personal.test", [
      {
        subject: "Personal note",
        from: "friend@example.com",
        bodyText: "Hello from personal",
      },
    ]);
    provider.seedAccount(work.id, "you@work.test", [
      {
        subject: "Work update",
        from: "boss@work.test",
        bodyText: "Hello from work",
      },
    ]);

    const accounts = mail.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.alias).sort()).toEqual(["personal", "work"]);

    // secrets stored encrypted, not plaintext
    const row = store.getAccount("personal");
    expect(row?.passwordEnc).toBeTruthy();
    expect(row?.passwordEnc).not.toContain(PERSONAL_PASS);
    expect(row?.authKind).toBe("password");
    expect(store.credentialsFor(row!).auth).toEqual({
      kind: "password",
      user: "you@personal.test",
      pass: PERSONAL_PASS,
    });

    const all = await mail.listMessages("all", { limit: 20 });
    expect(all.errors).toEqual([]);
    expect(all.messages.length).toBeGreaterThanOrEqual(2);
    const subjects = all.messages.map((m) => m.subject);
    expect(subjects).toEqual(
      expect.arrayContaining(["Personal note", "Work update"]),
    );
  });

  it("searches and reads body via real MailService", async () => {
    const personal = await mail.connectAccount({
      alias: "personal",
      email: "you@personal.test",
      creds: { ...baseCreds, auth: { kind: "password", user: "you@personal.test", pass: "ok" } },
    });
    provider.seedAccount(personal.id, "you@personal.test", [
      {
        subject: "Flight to Boston",
        from: "air@example.com",
        bodyText: "Boarding pass for BOS on Tuesday",
      },
      {
        subject: "Spam",
        from: "x@y.z",
        bodyText: "buy now",
      },
    ]);

    const hits = await mail.searchMessages("personal", { query: "Boston" });
    expect(hits.errors).toEqual([]);
    expect(hits.messages).toHaveLength(1);
    expect(hits.messages[0].subject).toBe("Flight to Boston");

    const full = await mail.getMessage("personal", hits.messages[0].id);
    expect(full?.bodyText).toContain("Boarding pass");
  });

  it("sends mail through shipped send path", async () => {
    await mail.connectAccount({
      alias: "work",
      email: "you@work.test",
      creds: { ...baseCreds, auth: { kind: "password", user: "you@work.test", pass: "ok" } },
    });
    const result = await mail.sendMessage("work", {
      to: "client@acme.test",
      subject: "Hello",
      text: "Shipped send path works",
    });
    expect(result.messageId).toBeTruthy();
    expect(result.accepted).toContain("client@acme.test");
    expect(provider.getSent()).toHaveLength(1);
    expect(provider.getSent()[0].subject).toBe("Hello");
  });

  it("rejects bad credentials on connect", async () => {
    await expect(
      mail.connectAccount({
        alias: "bad",
        email: "bad@test.com",
        creds: { ...baseCreds, auth: { kind: "password", user: "bad@test.com", pass: "bad" } },
      }),
    ).rejects.toThrow(/auth/i);
  });
});

describe("MailService drafts (shipped path, no delivery)", () => {
  let mail: MailService;
  let provider: FixtureProvider;

  beforeEach(async () => {
    const s = makeService();
    mail = s.mail;
    provider = s.provider;
    await mail.connectAccount({
      alias: "work",
      email: "you@work.test",
      creds: {
        ...baseCreds,
        auth: { kind: "password", user: "you@work.test", pass: "ok" },
      },
    });
  });

  it("stores a draft without sending anything", async () => {
    const draft = await mail.createDraft("work", {
      to: "client@acme.test",
      subject: "Proposal",
      text: "Draft body",
    });
    expect(draft.id).toBeTruthy();
    expect(draft.folder).toBe("Drafts");
    expect(draft.messageId).toBeTruthy();
    // The whole point of a draft: the send path was never touched.
    expect(provider.getSent()).toHaveLength(0);

    const drafts = await mail.listDrafts("work");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].subject).toBe("Proposal");
    expect(drafts[0].to).toBe("client@acme.test");
    expect(drafts[0].bodyText).toBe("Draft body");
  });

  it("keeps reply headers on a drafted reply", async () => {
    await mail.createDraft("work", {
      to: "client@acme.test",
      subject: "Re: Proposal",
      text: "answering",
      cc: "cc@acme.test",
      bcc: "quiet@acme.test",
      inReplyTo: "<orig@acme.test>",
      references: "<root@acme.test> <orig@acme.test>",
    });
    const [drafted] = await mail.listDrafts("work");
    expect(drafted.cc).toBe("cc@acme.test");
    expect(drafted.bcc).toBe("quiet@acme.test");
    expect(drafted.inReplyTo).toBe("<orig@acme.test>");
    expect(drafted.references).toBe("<root@acme.test> <orig@acme.test>");
  });

  it("replaces content on update and retires the old id", async () => {
    const first = await mail.createDraft("work", {
      to: "client@acme.test",
      subject: "Proposal",
      text: "v1",
    });
    const second = await mail.updateDraft("work", first.id, {
      to: "client@acme.test",
      subject: "Proposal v2",
      text: "v2",
    });
    expect(second.id).not.toBe(first.id);

    const drafts = await mail.listDrafts("work");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].subject).toBe("Proposal v2");
    expect(drafts[0].bodyText).toBe("v2");
    // The old id is dead: deleting it must not report success.
    expect(await mail.deleteDraft("work", first.id)).toBe(false);
  });

  it("deletes a draft and reports false the second time", async () => {
    const draft = await mail.createDraft("work", {
      subject: "Half written",
      text: "",
    });
    expect(await mail.deleteDraft("work", draft.id)).toBe(true);
    expect(await mail.listDrafts("work")).toHaveLength(0);
    expect(await mail.deleteDraft("work", draft.id)).toBe(false);
  });

  it("keeps drafts out of the inbox and names the folder \\Drafts", async () => {
    await mail.createDraft("work", { subject: "Hidden", text: "not inbox" });
    const inbox = await mail.listMessages("work", { limit: 20 });
    expect(inbox.messages.map((m) => m.subject)).not.toContain("Hidden");
    const folders = await mail.listFolders("work");
    expect(folders.find((f) => f.name === "Drafts")?.specialUse).toBe(
      "\\Drafts",
    );
  });

  it("rejects a draft for an unknown account", async () => {
    await expect(
      mail.createDraft("nope", { subject: "x", text: "y" }),
    ).rejects.toThrow(/account not found/i);
  });
});

describe("MCP JSON-RPC on shipped handlers", () => {
  it("lists tools including read and send", async () => {
    const { mail, provider } = makeService();
    const personal = await mail.connectAccount({
      alias: "personal",
      email: "p@test.com",
      creds: { ...baseCreds, auth: { kind: "password", user: "p@test.com", pass: "ok" } },
    });
    provider.seedAccount(personal.id, "p@test.com", [
      { subject: "Hi", from: "a@b.c", bodyText: "body" },
    ]);

    const listed = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as { result: { tools: Array<{ name: string }> } };

    const names = listed.result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "accounts_list",
        "messages_list",
        "messages_search",
        "message_get",
        "message_send",
      ]),
    );

    const inbox = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "messages_list", arguments: { account: "all" } },
    })) as { result: { content: Array<{ text: string }> } };

    const payload = JSON.parse(inbox.result.content[0].text);
    expect(payload.messages.length).toBeGreaterThan(0);

    const sent = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "message_send",
        arguments: {
          account: "personal",
          to: "z@test.com",
          subject: "MCP send",
          text: "from mcp",
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const sendPayload = JSON.parse(sent.result.content[0].text);
    expect(sendPayload.result.messageId).toBeTruthy();
  });
});

describe("HTTP API via createRuntime (shipped app)", () => {
  it("health, multi-account connect surface, list, send", async () => {
    const masterKey = randomBytes(32);
    const store = new Store(masterKey, ":memory:");
    const provider = new FixtureProvider();
    const runtime = createRuntime({
      dataDir: ":memory:",
      masterKey,
      bearerToken: "test-token",
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      store,
      provider,
      // Pinned to a fixture: `/` serving the real export is a property of the
      // build, not of this test. CI runs build:server only, so discovering
      // web-next/ here would make the result depend on whether someone had
      // run the Next export first.
      webRoot: WEB_FIXTURE,
    });

    const health = await runtime.app.request("/health");
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody.ok).toBe(true);

    const unauth = await runtime.app.request("/api/accounts");
    expect(unauth.status).toBe(401);

    // query-param auth was removed: a valid token in ?token= must not work
    const queryAuth = await runtime.app.request("/api/accounts?token=test-token");
    expect(queryAuth.status).toBe(401);

    const headers = {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    };

    const a1 = await runtime.app.request("/api/accounts", {
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
    expect(a1.status).toBe(201);

    const a2 = await runtime.app.request("/api/accounts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        alias: "work",
        email: "you@work.test",
        username: "you@work.test",
        password: "ok",
        imapHost: "fixture",
        smtpHost: "fixture",
      }),
    });
    expect(a2.status).toBe(201);
    const work = await a2.json();

    provider.seedAccount(work.account.id, "you@work.test", [
      {
        subject: "API seed",
        from: "n@test.com",
        bodyText: "via http",
      },
    ]);

    const list = await runtime.app.request("/api/messages?account=all", {
      headers,
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.messages.length).toBeGreaterThan(0);
    expect(listBody.errors).toEqual([]);

    // a non-numeric limit is rejected, not silently coerced into an empty list
    const badLimit = await runtime.app.request(
      "/api/messages?account=all&limit=abc",
      { headers },
    );
    expect(badLimit.status).toBe(400);

    const send = await runtime.app.request("/api/messages/send", {
      method: "POST",
      headers,
      body: JSON.stringify({
        account: "personal",
        to: "out@test.com",
        subject: "HTTP send",
        text: "hello",
      }),
    });
    expect(send.status).toBe(201);

    // Drafts: create -> list -> update -> delete, all over the same auth gate.
    const draftsUnauth = await runtime.app.request("/api/drafts?account=personal");
    expect(draftsUnauth.status).toBe(401);

    const created = await runtime.app.request("/api/drafts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        account: "personal",
        to: "out@test.com",
        subject: "HTTP draft",
        text: "v1",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.draft.id).toBeTruthy();

    const draftList = await runtime.app.request("/api/drafts?account=personal", {
      headers,
    });
    expect(draftList.status).toBe(200);
    const draftListBody = await draftList.json();
    expect(draftListBody.drafts).toHaveLength(1);
    expect(draftListBody.drafts[0].subject).toBe("HTTP draft");

    // account=all is refused: a draft belongs to exactly one mailbox.
    const draftsAll = await runtime.app.request("/api/drafts?account=all", {
      headers,
    });
    expect(draftsAll.status).toBe(400);

    const updated = await runtime.app.request(
      `/api/drafts/personal/${encodeURIComponent(createdBody.draft.id)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          to: "out@test.com",
          subject: "HTTP draft v2",
          text: "v2",
        }),
      },
    );
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.draft.id).not.toBe(createdBody.draft.id);

    const removed = await runtime.app.request(
      `/api/drafts/personal/${encodeURIComponent(updatedBody.draft.id)}`,
      { method: "DELETE", headers },
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).deleted).toBe(true);

    const removedAgain = await runtime.app.request(
      `/api/drafts/personal/${encodeURIComponent(updatedBody.draft.id)}`,
      { method: "DELETE", headers },
    );
    expect(removedAgain.status).toBe(404);

    const home = await runtime.app.request("/");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("<title>mailmux</title>");

    const mcpInit = await runtime.app.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    expect(mcpInit.status).toBe(200);
    const mcpBody = await mcpInit.json();
    expect(mcpBody.result.serverInfo.name).toBe("mailmux");

    runtime.store.close();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { encryptSecret, decryptSecret } from "../src/crypto/secrets.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";
import { createRuntime } from "../src/app.js";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("round-trips the empty string", () => {
    const key = randomBytes(32);
    const enc = encryptSecret(key, "");
    // GCM emits no ciphertext for "", so the payload is nonce + tag only.
    expect(Buffer.from(enc, "base64")).toHaveLength(12 + 16);
    expect(decryptSecret(key, enc)).toBe("");
  });

  it("rejects a payload too short to hold a nonce and tag", () => {
    const key = randomBytes(32);
    const short = randomBytes(12 + 15).toString("base64");
    expect(() => decryptSecret(key, short)).toThrow("invalid secret payload");
  });

  it("still rejects a full-length payload that fails authentication", () => {
    const key = randomBytes(32);
    const forged = randomBytes(12 + 16).toString("base64");
    // Long enough to pass the length guard, so GCM has to be what stops it.
    expect(() => decryptSecret(key, forged)).toThrow();
    expect(() => decryptSecret(key, forged)).not.toThrow("invalid secret payload");
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

  it("sends mail with file attachments and validates missing files", async () => {
    await mail.connectAccount({
      alias: "work",
      email: "you@work.test",
      creds: { ...baseCreds, auth: { kind: "password", user: "you@work.test", pass: "ok" } },
    });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "boxaide-mailcore-att-")));
    const filePath = join(dir, "doc.pdf");
    writeFileSync(filePath, "%PDF document content");
    process.env.BOXAIDE_ATTACHMENT_DIRS = dir;
    const symlinkRoot = join(tmpdir(), `boxaide-att-link-${process.pid}`);
    rmSync(symlinkRoot, { force: true });
    symlinkSync(dir, symlinkRoot);

    try {
      const result = await mail.sendMessage("work", {
        to: "founder@startup.test",
        subject: "Contract",
        text: "Attached contract",
        attachments: [{ path: filePath, filename: "contract.pdf" }],
      });
      expect(result.messageId).toBeTruthy();
      expect(provider.getSent()[0].attachments).toHaveLength(1);
      expect(provider.getSent()[0].attachments![0].filename).toBe("contract.pdf");
      expect(provider.getSent()[0].attachments![0].path).toBe(filePath);

      // Missing file rejects
      await expect(
        mail.sendMessage("work", {
          to: "founder@startup.test",
          subject: "Contract",
          text: "Missing file",
          attachments: [{ path: join(dir, "nonexistent.pdf") }],
        }),
      ).rejects.toThrow(/attachment file not found/);

      // A root named through a symlink still matches: on macOS the tmp dir
      // is reached as /tmp but lives at /private/tmp.
      process.env.BOXAIDE_ATTACHMENT_DIRS = symlinkRoot;
      const viaLink = await mail.sendMessage("work", {
        to: "founder@startup.test",
        subject: "Contract",
        text: "Attached through a symlinked root",
        attachments: [{ path: filePath }],
      });
      expect(viaLink.messageId).toBeTruthy();
      process.env.BOXAIDE_ATTACHMENT_DIRS = dir;

      // A hidden file inside an allowed directory is still refused.
      const hidden = join(dir, ".env");
      writeFileSync(hidden, "SECRET=1");
      await expect(
        mail.sendMessage("work", {
          to: "founder@startup.test",
          subject: "Contract",
          text: "Hidden file",
          attachments: [{ path: hidden }],
        }),
      ).rejects.toThrow(/hidden file or directory/);
    } finally {
      delete process.env.BOXAIDE_ATTACHMENT_DIRS;
      rmSync(symlinkRoot, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(mcpBody.result.serverInfo.name).toBe("boxaide");

    runtime.store.close();
  });
});

describe("archive over HTTP (shipped routes)", () => {
  /** A runtime with one connected account and one seeded inbox message. */
  async function withMessage() {
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
      webRoot: WEB_FIXTURE,
    });
    const headers = {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    };
    const connected = await runtime.app.request("/api/accounts", {
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
    provider.seedAccount(account.id, "you@personal.test", [
      { subject: "Filed away", from: "n@test.com", bodyText: "archive me" },
    ]);
    const listed = await runtime.app.request(
      "/api/messages?account=personal",
      { headers },
    );
    const message = (await listed.json()).messages[0];
    return { runtime, headers, message };
  }

  const archive = (
    runtime: { app: { request: typeof fetch } },
    headers: Record<string, string>,
    id: string,
  ) =>
    runtime.app.request(
      `/api/messages/personal/${encodeURIComponent(id)}/archive`,
      { method: "POST", headers },
    );

  it("moves a message to Archive and reports both mailboxes", async () => {
    const { runtime, headers, message } = await withMessage();
    const res = await archive(runtime, headers, message.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      moved: true,
      fromFolder: "INBOX",
      toFolder: "Archive",
    });

    const inbox = await runtime.app.request("/api/messages?account=personal", {
      headers,
    });
    const subjects = (await inbox.json()).messages.map(
      (m: { subject: string }) => m.subject,
    );
    expect(subjects).not.toContain("Filed away");

    const archived = await runtime.app.request(
      "/api/messages?account=personal&folder=Archive",
      { headers },
    );
    expect(
      (await archived.json()).messages.map((m: { subject: string }) => m.subject),
    ).toContain("Filed away");
    runtime.store.close();
  });

  it("puts an archived message back through the move route", async () => {
    const { runtime, headers, message } = await withMessage();
    const archived = await (await archive(runtime, headers, message.id)).json();

    const back = await runtime.app.request(
      `/api/messages/personal/${encodeURIComponent(archived.id)}/move`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ folder: archived.fromFolder }),
      },
    );
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({
      moved: true,
      fromFolder: "Archive",
      toFolder: "INBOX",
    });
    runtime.store.close();
  });

  it("answers 404 when the message already left the folder", async () => {
    const { runtime, headers, message } = await withMessage();
    const gone = `${message.accountId}:9999`;
    const res = await archive(runtime, headers, gone);
    expect(res.status).toBe(404);
    runtime.store.close();
  });

  it("rejects a move with no destination folder", async () => {
    const { runtime, headers, message } = await withMessage();
    const res = await runtime.app.request(
      `/api/messages/personal/${encodeURIComponent(message.id)}/move`,
      { method: "POST", headers, body: JSON.stringify({ folder: "  " }) },
    );
    expect(res.status).toBe(400);
    runtime.store.close();
  });

  const trash = (
    runtime: { app: { request: typeof fetch } },
    headers: Record<string, string>,
    id: string,
  ) =>
    runtime.app.request(
      `/api/messages/personal/${encodeURIComponent(id)}/trash`,
      { method: "POST", headers },
    );

  it("deletes by moving to Trash, and says which mailboxes", async () => {
    const { runtime, headers, message } = await withMessage();
    const res = await trash(runtime, headers, message.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      moved: true,
      fromFolder: "INBOX",
      toFolder: "Trash",
    });

    const inbox = await runtime.app.request("/api/messages?account=personal", {
      headers,
    });
    expect(
      (await inbox.json()).messages.map((m: { subject: string }) => m.subject),
    ).not.toContain("Filed away");

    // Still on the server, in the mailbox the user's own client calls Trash.
    // Nothing was expunged, which is the whole claim Delete makes here.
    const deleted = await runtime.app.request(
      "/api/messages?account=personal&folder=Trash",
      { headers },
    );
    expect(
      (await deleted.json()).messages.map((m: { subject: string }) => m.subject),
    ).toContain("Filed away");
    runtime.store.close();
  });

  it("puts a deleted message back through the move route", async () => {
    const { runtime, headers, message } = await withMessage();
    const deleted = await (await trash(runtime, headers, message.id)).json();

    const back = await runtime.app.request(
      `/api/messages/personal/${encodeURIComponent(deleted.id)}/move`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ folder: deleted.fromFolder }),
      },
    );
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({
      moved: true,
      fromFolder: "Trash",
      toFolder: "INBOX",
    });
    runtime.store.close();
  });

  it("answers 404 when the message to delete already left the folder", async () => {
    const { runtime, headers, message } = await withMessage();
    const res = await trash(runtime, headers, `${message.accountId}:9999`);
    expect(res.status).toBe(404);
    runtime.store.close();
  });

  it("refuses to delete a draft, and says where to do it instead", async () => {
    const { runtime, headers } = await withMessage();
    const created = await runtime.app.request("/api/drafts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        account: "personal",
        to: "someone@test.com",
        subject: "Half written",
        text: "…",
      }),
    });
    const draft = (await created.json()).draft;
    const res = await trash(runtime, headers, draft.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("draft tools");
    runtime.store.close();
  });

  it("refuses both routes without a bearer token", async () => {
    const { runtime, headers, message } = await withMessage();
    const path = `/api/messages/personal/${encodeURIComponent(message.id)}`;
    expect(
      (await runtime.app.request(`${path}/archive`, { method: "POST" })).status,
    ).toBe(401);
    expect(
      (await runtime.app.request(`${path}/trash`, { method: "POST" })).status,
    ).toBe(401);
    expect(
      (
        await runtime.app.request(`${path}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder: "Archive" }),
        })
      ).status,
    ).toBe(401);
    // The same call with the token is not a 401, so the gate is what refused.
    expect((await archive(runtime, headers, message.id)).status).toBe(200);
    runtime.store.close();
  });
});

describe("Store.open database name", () => {
  it("opens boxaide.db when neither file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "boxaide-db-"));
    const store = Store.open(dir, randomBytes(32));
    store.close();
    expect(existsSync(join(dir, "boxaide.db"))).toBe(true);
    expect(existsSync(join(dir, "sley.db"))).toBe(false);
    expect(existsSync(join(dir, "mailmux.db"))).toBe(false);
  });

  // The rows have to come across, not just the file: a migration that renamed
  // an empty database onto the current name would read as a working install
  // with an empty mailbox, which is the failure nobody notices in time.
  it("renames sley.db onto boxaide.db and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "boxaide-db-"));
    const key = randomBytes(32);
    writeFileSync(join(dir, "sley.db"), "");
    const first = new Store(key, join(dir, "sley.db"));
    first.appendTurn({
      at: new Date().toISOString(),
      role: "user",
      text: "sley",
      agent: null,
    });
    first.close();
    const store = Store.open(dir, key);
    expect(store.listTurns().map((t) => t.text)).toEqual(["sley"]);
    store.close();
    expect(existsSync(join(dir, "boxaide.db"))).toBe(true);
    expect(existsSync(join(dir, "sley.db"))).toBe(false);
  });

  it("renames mailmux.db onto boxaide.db and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "boxaide-db-"));
    const key = randomBytes(32);
    writeFileSync(join(dir, "mailmux.db"), "");
    const first = new Store(key, join(dir, "mailmux.db"));
    first.appendTurn({
      at: new Date().toISOString(),
      role: "user",
      text: "legacy",
      agent: null,
    });
    first.close();
    const store = Store.open(dir, key);
    expect(store.listTurns().map((t) => t.text)).toEqual(["legacy"]);
    store.close();
    expect(existsSync(join(dir, "boxaide.db"))).toBe(true);
    expect(existsSync(join(dir, "mailmux.db"))).toBe(false);
  });
});

describe("MailService send guard recipients", () => {
  async function connected() {
    const { store, provider, mail } = makeService();
    await mail.connectAccount({
      alias: "personal",
      email: "you@personal.test",
      creds: baseCreds,
    });
    provider.clear();
    const seen: string[][] = [];
    mail.setSendGuard((recipients) => {
      seen.push(recipients);
    });
    return { store, provider, mail, seen };
  }

  it("hands the guard punycoded keys for a unicode IDN domain", async () => {
    const { store, mail, seen } = await connected();
    await mail.sendMessage("personal", {
      to: "User@München.de",
      subject: "s",
      text: "t",
    });
    expect(seen).toEqual([["user@xn--mnchen-3ya.de"]]);
    store.close();
  });

  // Fails closed with no guard installed too: the provider must never be
  // handed a recipient shape it was not typed for.
  it.each([
    ["to", { to: { address: "a@x.test" } }],
    ["cc", { to: "a@x.test", cc: { address: "b@x.test" } }],
    ["bcc", { to: "a@x.test", bcc: ["c@x.test"] }],
  ])("throws on a non-string %s before any send", async (_label, fields) => {
    const { store, provider, mail } = makeService();
    await mail.connectAccount({
      alias: "personal",
      email: "you@personal.test",
      creds: baseCreds,
    });
    provider.clear();
    await expect(
      mail.sendMessage("personal", {
        subject: "s",
        text: "t",
        ...(fields as { to: string }),
      }),
    ).rejects.toThrow("invalid recipients: to/cc/bcc must be strings");
    expect(provider.getSent()).toHaveLength(0);
    store.close();
  });
});

describe("MailService.listFolderTree (additive, index-backed)", () => {
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

  it("groups one mailbox and carries the index's unread number", async () => {
    const work = mail.listAccounts()[0];
    provider.seedAccount(work.id, "you@work.test", [
      { subject: "Unread one", from: "a@b.c", bodyText: "x", seen: false },
      { subject: "Unread two", from: "a@b.c", bodyText: "y", seen: false },
      { subject: "Read one", from: "a@b.c", bodyText: "z", seen: true },
    ]);
    // The index only knows a folder once a list has filled it.
    await mail.listMessages("work", { limit: 20 });

    const result = await mail.listFolderTree("work");
    expect(result.errors).toEqual([]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].alias).toBe("work");
    expect(result.groups[0].email).toBe("you@work.test");

    const inbox = result.groups[0].folders.find((f) => f.path === "INBOX")!;
    expect(inbox.unread).toEqual({ count: 2, exact: true });
    expect(inbox.delimiter).toBe("/");

    // The old method is untouched and still answers a bare array.
    const flat = await mail.listFolders("work");
    expect(flat.find((f) => f.path === "INBOX")).toBeTruthy();
    expect("unread" in flat[0]).toBe(false);
  });

  it("omits unread entirely for a folder the index never synced", async () => {
    const work = mail.listAccounts()[0];
    provider.seedAccount(work.id, "you@work.test", [
      { subject: "Filed", from: "a@b.c", bodyText: "x", folder: "Receipts" },
    ]);
    const result = await mail.listFolderTree("work");
    const receipts = result.groups[0].folders.find(
      (f) => f.path === "Receipts",
    )!;
    expect(receipts.unread).toBeUndefined();
  });

  it("returns a group per account and an empty errors array for all", async () => {
    await mail.connectAccount({
      alias: "personal",
      email: "you@personal.test",
      creds: {
        ...baseCreds,
        auth: { kind: "password", user: "you@personal.test", pass: "ok" },
      },
    });
    const result = await mail.listFolderTree("all");
    expect(result.errors).toEqual([]);
    expect(result.groups.map((g) => g.alias)).toEqual(["work", "personal"]);
  });

  it("keeps a single unreachable mailbox out of the way of the rest", async () => {
    await mail.connectAccount({
      alias: "broken",
      email: "you@broken.test",
      creds: {
        ...baseCreds,
        auth: { kind: "password", user: "you@broken.test", pass: "ok" },
      },
    });
    const broken = mail.listAccounts().find((a) => a.alias === "broken")!;
    const orig = provider.listFolders.bind(provider);
    provider.listFolders = async (account) => {
      if (account.id === broken.id) throw new Error("connect ECONNREFUSED");
      return orig(account);
    };

    const result = await mail.listFolderTree("all");
    expect(result.groups.map((g) => g.alias)).toEqual(["work"]);
    expect(result.errors).toEqual([
      { account: "broken", error: "connect ECONNREFUSED" },
    ]);
  });

  it("throws for one named mailbox that does not exist", async () => {
    await expect(mail.listFolderTree("nosuch")).rejects.toThrow(
      /account not found: nosuch/,
    );
  });
});

describe("GET /api/folders over HTTP (shipped routes)", () => {
  async function runtimeWithAccounts() {
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
      webRoot: WEB_FIXTURE,
    });
    const headers = {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    };
    for (const alias of ["work", "personal"]) {
      const res = await runtime.app.request("/api/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          alias,
          email: `you@${alias}.test`,
          username: `you@${alias}.test`,
          password: "ok",
          imapHost: "fixture",
          smtpHost: "fixture",
        }),
      });
      expect(res.status).toBe(201);
    }
    return { runtime, headers };
  }

  it("answers account=all with groups and errors", async () => {
    const { runtime, headers } = await runtimeWithAccounts();
    const res = await runtime.app.request("/api/folders?account=all", {
      headers,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.groups.map((g: { alias: string }) => g.alias)).toEqual([
      "work",
      "personal",
    ]);
    expect(body.errors).toEqual([]);
    expect(body.folders).toBeUndefined();
  });

  it("still 400s on an empty account", async () => {
    const { runtime, headers } = await runtimeWithAccounts();
    const res = await runtime.app.request("/api/folders?account=", { headers });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "account is required" });
  });

  it("keeps the flat { folders } shape for one named mailbox", async () => {
    const { runtime, headers } = await runtimeWithAccounts();
    const res = await runtime.app.request("/api/folders?account=work", {
      headers,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.folders)).toBe(true);
    expect(body.folders.map((f: { path: string }) => f.path)).toContain("INBOX");
    expect(body.groups).toBeUndefined();
  });

  it("400s on an account that does not exist", async () => {
    const { runtime, headers } = await runtimeWithAccounts();
    const res = await runtime.app.request("/api/folders?account=nosuch", {
      headers,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/account not found: nosuch/);
  });
});

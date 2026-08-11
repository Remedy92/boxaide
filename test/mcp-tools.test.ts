import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";

const ALL_TOOLS = [
  "accounts_list",
  "messages_list",
  "messages_search",
  "message_get",
  "message_send",
  "message_mark_read",
  "draft_create",
  "draft_update",
  "drafts_list",
  "draft_delete",
  "folders_list",
];

const baseCreds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "p@test.com", pass: "ok" },
};

type ToolResult = { result: { content: Array<{ text: string }> } };
type RpcError = { error: { code: number; message: string } };

async function call(
  mail: MailService,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return handleMcpJsonRpc(mail, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function payloadOf(res: unknown): any {
  return JSON.parse((res as ToolResult).result.content[0].text);
}

describe("MCP tool surface", () => {
  let mail: MailService;
  let provider: FixtureProvider;
  let messageId: string;

  beforeEach(async () => {
    const store = new Store(randomBytes(32), ":memory:");
    provider = new FixtureProvider();
    mail = new MailService(store, provider);
    const account = await mail.connectAccount({
      alias: "personal",
      email: "p@test.com",
      creds: baseCreds,
    });
    provider.seedAccount(account.id, "p@test.com", [
      {
        subject: "Original thread",
        from: "a@b.c",
        bodyText: "body",
        messageId: "<orig@example.com>",
      },
    ]);
    const listed = await mail.listMessages("personal", { limit: 10 });
    messageId = listed.messages[0].id;
  });

  it("advertises all eleven tools with input schemas", async () => {
    const listed = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    const names = listed.result.tools.map((t) => t.name);
    expect(names.sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of listed.result.tools) {
      expect(tool.inputSchema, tool.name).toBeTruthy();
    }
  });

  it("tells agents drafting is the default and sending is the escalation", async () => {
    const listed = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as { result: { tools: Array<{ name: string; description: string }> } };
    const byName = new Map(
      listed.result.tools.map((t) => [t.name, t.description]),
    );
    for (const name of ["draft_create", "draft_update", "drafts_list"]) {
      expect(byName.get(name), name).toMatch(/safe default/i);
      expect(byName.get(name), name).toMatch(/message_send/);
    }
    // The escalation says so on its own card too — an agent that only reads
    // message_send must still learn drafting exists.
    expect(byName.get("message_send")).toMatch(/escalation/i);
    expect(byName.get("message_send")).toMatch(/draft_create/);
  });

  it("forwards inReplyTo and references on message_send", async () => {
    const res = await call(mail, "message_send", {
      account: "personal",
      to: "z@test.com",
      subject: "Re: Original thread",
      text: "replying",
      inReplyTo: "<orig@example.com>",
      references: "<root@example.com> <orig@example.com>",
    });
    expect(payloadOf(res).result.messageId).toBeTruthy();

    const sent = provider.getSent();
    expect(sent).toHaveLength(1);
    expect(sent[0].inReplyTo).toBe("<orig@example.com>");
    expect(sent[0].references).toBe("<root@example.com> <orig@example.com>");
  });

  it("leaves inReplyTo and references undefined when not supplied", async () => {
    await call(mail, "message_send", {
      account: "personal",
      to: "z@test.com",
      subject: "Fresh",
      text: "new thread",
    });
    const sent = provider.getSent();
    expect(sent[0].inReplyTo).toBeUndefined();
    expect(sent[0].references).toBeUndefined();
  });

  it("returns a JSON-RPC error for an unknown tool", async () => {
    const res = (await call(mail, "message_delete", {})) as RpcError;
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/unknown tool: message_delete/i);
    expect((res as { result?: unknown }).result).toBeUndefined();
  });

  it("returns a JSON-RPC error for an unknown method", async () => {
    const res = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 9,
      method: "resources/list",
    })) as RpcError;
    expect(res.error.code).toBe(-32601);
  });

  it("reports a failed known tool as an isError result, not a protocol error", async () => {
    const res = (await call(mail, "message_get", {
      account: "personal",
      messageId: "does-not-exist",
    })) as ToolResult & { result: { isError?: boolean } };
    expect(res.result.isError).toBe(true);
    expect(payloadOf(res).error).toMatch(/not found/i);
  });

  it("marks a message read through message_mark_read", async () => {
    const res = await call(mail, "message_mark_read", {
      account: "personal",
      messageId,
      seen: true,
    });
    expect(payloadOf(res)).toEqual({ updated: true });
    const listed = await mail.listMessages("personal", { limit: 10 });
    expect(listed.messages[0].seen).toBe(true);
  });

  it("drafts a reply through draft_create without sending it", async () => {
    const res = await call(mail, "draft_create", {
      account: "personal",
      to: "z@test.com",
      subject: "Re: Original thread",
      text: "drafted, not sent",
      inReplyTo: "<orig@example.com>",
      references: "<orig@example.com>",
    });
    const draft = payloadOf(res).draft;
    expect(draft.id).toBeTruthy();
    expect(draft.folder).toBe("Drafts");
    expect(provider.getSent()).toHaveLength(0);

    const listed = payloadOf(await call(mail, "drafts_list", {
      account: "personal",
    }));
    expect(listed.drafts).toHaveLength(1);
    expect(listed.drafts[0].id).toBe(draft.id);
    expect(listed.drafts[0].inReplyTo).toBe("<orig@example.com>");
    expect(listed.drafts[0].bodyText).toBe("drafted, not sent");
  });

  it("leaves omitted draft fields undefined rather than empty strings", async () => {
    await call(mail, "draft_create", {
      account: "personal",
      subject: "Just a subject",
    });
    const listed = payloadOf(await call(mail, "drafts_list", {
      account: "personal",
    }));
    expect(listed.drafts[0].subject).toBe("Just a subject");
    expect(listed.drafts[0].cc).toBeUndefined();
    expect(listed.drafts[0].inReplyTo).toBeUndefined();
  });

  it("replaces a draft through draft_update and returns a new id", async () => {
    const first = payloadOf(await call(mail, "draft_create", {
      account: "personal",
      subject: "v1",
      text: "one",
    })).draft;
    const second = payloadOf(await call(mail, "draft_update", {
      account: "personal",
      draftId: first.id,
      subject: "v2",
      text: "two",
    })).draft;
    expect(second.id).not.toBe(first.id);

    const listed = payloadOf(await call(mail, "drafts_list", {
      account: "personal",
    }));
    expect(listed.drafts).toHaveLength(1);
    expect(listed.drafts[0].subject).toBe("v2");
    expect(listed.drafts[0].bodyText).toBe("two");
  });

  it("discards a draft through draft_delete, and reports the second try", async () => {
    const draft = payloadOf(await call(mail, "draft_create", {
      account: "personal",
      subject: "Discard me",
    })).draft;
    expect(payloadOf(await call(mail, "draft_delete", {
      account: "personal",
      draftId: draft.id,
    }))).toEqual({ deleted: true });
    expect(payloadOf(await call(mail, "draft_delete", {
      account: "personal",
      draftId: draft.id,
    }))).toEqual({ deleted: false });
    expect(payloadOf(await call(mail, "drafts_list", { account: "personal" }))
      .drafts).toHaveLength(0);
  });

  it("reports an unknown draft on update as an isError result", async () => {
    const res = (await call(mail, "draft_update", {
      account: "personal",
      draftId: "personal:Drafts:999",
      text: "nope",
    })) as ToolResult & { result: { isError?: boolean } };
    expect(res.result.isError).toBe(true);
    expect(payloadOf(res).error).toMatch(/draft not found/i);
  });

  it("lists folders for one account", async () => {
    const res = await call(mail, "folders_list", { account: "personal" });
    expect(payloadOf(res).folders.map((f: { name: string }) => f.name)).toContain(
      "INBOX",
    );
  });

  it("answers ping and swallows notifications/initialized", async () => {
    const ping = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 3,
      method: "ping",
    })) as { result: unknown };
    expect(ping.result).toEqual({});
    expect(
      await handleMcpJsonRpc(mail, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeNull();
  });

  it("echoes the client's requested protocolVersion on initialize", async () => {
    const res = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })) as { result: { protocolVersion: string } };
    expect(res.result.protocolVersion).toBe("2025-06-18");
  });
});

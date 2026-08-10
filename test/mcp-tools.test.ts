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

  it("advertises all seven tools with input schemas", async () => {
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

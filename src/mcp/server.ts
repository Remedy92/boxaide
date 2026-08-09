import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MailService } from "../mail/service.js";

const TOOLS = [
  {
    name: "accounts_list",
    description: "List connected mail accounts (alias, email, id).",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "messages_list",
    description:
      "List messages from one account (alias/id) or all accounts. Unified inbox when account is 'all'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: {
          type: "string",
          description: "Account alias, id, or 'all'",
          default: "all",
        },
        limit: { type: "number", default: 25 },
        folder: { type: "string", default: "INBOX" },
        unreadOnly: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "messages_search",
    description: "Search messages by free-text query across one or all accounts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        account: { type: "string", default: "all" },
        limit: { type: "number", default: 25 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "message_get",
    description: "Read a full message body by account and message id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string" },
        messageId: { type: "string" },
      },
      required: ["account", "messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "message_send",
    description:
      "Send an email from a connected account. Requires explicit user confirmation in the agent client.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
      },
      required: ["account", "to", "subject", "text"],
      additionalProperties: false,
    },
  },
];

export function createMcpServer(mail: MailService): Server {
  const server = new Server(
    { name: "mailmux", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await dispatch(mail, name, args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

async function dispatch(
  mail: MailService,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "accounts_list":
      return { accounts: mail.listAccounts() };
    case "messages_list":
      return {
        messages: await mail.listMessages(
          String(args.account ?? "all"),
          {
            limit: Number(args.limit ?? 25),
            folder: args.folder ? String(args.folder) : undefined,
            unreadOnly: Boolean(args.unreadOnly),
          },
        ),
      };
    case "messages_search":
      return {
        messages: await mail.searchMessages(String(args.account ?? "all"), {
          query: String(args.query ?? ""),
          limit: Number(args.limit ?? 25),
        }),
      };
    case "message_get": {
      const message = await mail.getMessage(
        String(args.account),
        String(args.messageId),
      );
      if (!message) throw new Error("message not found");
      return { message };
    }
    case "message_send":
      return {
        result: await mail.sendMessage(String(args.account), {
          to: String(args.to),
          subject: String(args.subject),
          text: String(args.text),
          html: args.html ? String(args.html) : undefined,
          cc: args.cc ? String(args.cc) : undefined,
          bcc: args.bcc ? String(args.bcc) : undefined,
        }),
      };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function runStdioMcp(mail: MailService): Promise<void> {
  const server = createMcpServer(mail);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Process a single JSON-RPC line for tests / HTTP bridge. */
export async function handleMcpJsonRpc(
  mail: MailService,
  message: {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: unknown;
  },
): Promise<unknown> {
  const id = message.id ?? null;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mailmux", version: "0.1.0" },
      },
    };
  }
  if (message.method === "notifications/initialized") {
    return null;
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (message.method === "tools/call") {
    const params = message.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    try {
      const result = await dispatch(
        mail,
        params.name,
        params.arguments ?? {},
      );
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true,
        },
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${message.method}` },
  };
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MailService } from "../mail/service.js";
import type { DraftInput } from "../provider/types.js";

const PROTOCOL_VERSION = "2024-11-05";

const MESSAGE_ID_DESC =
  "Message id from messages_list/messages_search, format 'accountId:folder:uid'.";

const DRAFT_ID_DESC =
  "Draft id from drafts_list or from a draft_create/draft_update result, format 'accountId:folder:uid'.";

/** Repeated verbatim on every draft tool so the safe default is unmissable. */
const DRAFT_SAFETY =
  "Drafting is the safe default: nothing is delivered and the user can edit or discard it in their own mail client. Prefer this over message_send, which is the explicit escalation and needs the user to say they want the mail sent.";

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
      "List message summaries from one account (alias/id) or all accounts. Unified inbox when account is 'all'. Returns { messages, errors }; a non-empty errors array means some accounts failed and the list is incomplete.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: {
          type: "string",
          description: "Account alias, id, or 'all'",
          default: "all",
        },
        limit: { type: "number", default: 25 },
        folder: {
          type: "string",
          description: "Folder path from folders_list.",
          default: "INBOX",
        },
        unreadOnly: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "messages_search",
    description:
      "Search message summaries by free-text query across one or all accounts. Returns { messages, errors }; a non-empty errors array means the result is incomplete.",
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
    description: "Read one full message, including body, by account and message id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias or id." },
        messageId: { type: "string", description: MESSAGE_ID_DESC },
      },
      required: ["account", "messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "message_send",
    description:
      "Deliver an email from a connected account. This is the explicit escalation, not the default: it leaves the machine immediately and cannot be recalled, so use draft_create instead unless the user has asked for the mail to be sent. To reply in-thread, set inReplyTo and references from the Message-ID header of the message you answer. Requires explicit user confirmation in the agent client.",
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
        inReplyTo: {
          type: "string",
          description:
            "Message-ID header of the message being replied to, e.g. '<abc@host>'. Not the accountId:folder:uid id.",
        },
        references: {
          type: "string",
          description:
            "Space-separated Message-ID chain of the thread, oldest first.",
        },
      },
      required: ["account", "to", "subject", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "message_mark_read",
    description:
      "Set or clear the read (\\Seen) flag on one message. Returns { updated: false } when the message is gone.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias or id." },
        messageId: { type: "string", description: MESSAGE_ID_DESC },
        seen: {
          type: "boolean",
          description: "true marks read, false marks unread.",
          default: true,
        },
      },
      required: ["account", "messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_create",
    description: `Save a new draft into an account's Drafts folder. ${DRAFT_SAFETY} Every field except account is optional, so a half-written draft is fine. To draft a reply in-thread, set inReplyTo and references from the Message-ID header of the message you answer.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias or id." },
        to: { type: "string" },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        inReplyTo: {
          type: "string",
          description:
            "Message-ID header of the message being replied to, e.g. '<abc@host>'. Not the accountId:folder:uid id.",
        },
        references: {
          type: "string",
          description:
            "Space-separated Message-ID chain of the thread, oldest first.",
        },
      },
      required: ["account"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_update",
    description: `Replace the content of an existing draft. ${DRAFT_SAFETY} The whole draft is replaced, so send every field you want kept — omitted fields are dropped, not merged. Returns a NEW draftId; the old one stops working.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias or id." },
        draftId: { type: "string", description: DRAFT_ID_DESC },
        to: { type: "string" },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        inReplyTo: { type: "string" },
        references: { type: "string" },
      },
      required: ["account", "draftId"],
      additionalProperties: false,
    },
  },
  {
    name: "drafts_list",
    description: `List the drafts of one account, newest first, with their full body text. Read this before draft_update so you keep the fields you are not changing. ${DRAFT_SAFETY}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias or id." },
        limit: { type: "number", default: 25 },
      },
      required: ["account"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_delete",
    description:
      "Discard one draft. Returns { deleted: false } when the draft is already gone. This removes unsent text only — it never touches delivered mail.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias or id." },
        draftId: { type: "string", description: DRAFT_ID_DESC },
      },
      required: ["account", "draftId"],
      additionalProperties: false,
    },
  },
  {
    name: "folders_list",
    description:
      "List the mail folders of one account. Use a returned path as the folder argument of messages_list.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias or id." },
      },
      required: ["account"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

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

/**
 * Draft fields, each left undefined when absent. A draft is allowed to be
 * half-written, so an empty string must not be coerced in for a missing field.
 */
function draftFields(args: Record<string, unknown>): DraftInput {
  const str = (v: unknown): string | undefined =>
    v === undefined || v === null ? undefined : String(v);
  return {
    to: str(args.to),
    subject: str(args.subject),
    text: str(args.text),
    html: str(args.html),
    cc: str(args.cc),
    bcc: str(args.bcc),
    inReplyTo: str(args.inReplyTo),
    references: str(args.references),
  };
}

async function dispatch(
  mail: MailService,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "accounts_list":
      return { accounts: mail.listAccounts() };
    case "messages_list": {
      const { messages, errors } = await mail.listMessages(
        String(args.account ?? "all"),
        {
          limit: Number(args.limit ?? 25),
          folder: args.folder ? String(args.folder) : undefined,
          unreadOnly: Boolean(args.unreadOnly),
        },
      );
      return errors.length ? { messages, errors } : { messages };
    }
    case "messages_search": {
      const { messages, errors } = await mail.searchMessages(
        String(args.account ?? "all"),
        {
          query: String(args.query ?? ""),
          limit: Number(args.limit ?? 25),
        },
      );
      return errors.length ? { messages, errors } : { messages };
    }
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
          inReplyTo: args.inReplyTo ? String(args.inReplyTo) : undefined,
          references: args.references ? String(args.references) : undefined,
        }),
      };
    case "message_mark_read":
      return {
        updated: await mail.markRead(
          String(args.account),
          String(args.messageId),
          args.seen === undefined ? true : Boolean(args.seen),
        ),
      };
    case "draft_create":
      return {
        draft: await mail.createDraft(String(args.account), draftFields(args)),
      };
    case "draft_update":
      return {
        draft: await mail.updateDraft(
          String(args.account),
          String(args.draftId),
          draftFields(args),
        ),
      };
    case "drafts_list":
      return {
        drafts: await mail.listDrafts(String(args.account), {
          limit: Number(args.limit ?? 25),
        }),
      };
    case "draft_delete":
      return {
        deleted: await mail.deleteDraft(
          String(args.account),
          String(args.draftId),
        ),
      };
    case "folders_list":
      return { folders: await mail.listFolders(String(args.account)) };
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
    const requested = (message.params as { protocolVersion?: unknown } | undefined)
      ?.protocolVersion;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          typeof requested === "string" && requested ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "mailmux", version: "0.1.0" },
      },
    };
  }
  if (message.method === "notifications/initialized") {
    return null;
  }
  if (message.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (message.method === "tools/call") {
    const params = message.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    if (!TOOL_NAMES.has(params.name)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${params.name}` },
      };
    }
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

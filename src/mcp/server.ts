import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentChannel } from "../agent/channel.js";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "../agent/channel.js";
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

/**
 * Exported for one consumer besides this module: the Claude Desktop connector
 * (apps/mcpb) bakes this list into its bundle so it can answer `tools/list`
 * while the server is not running. scripts/export-mcpb-tools.mjs writes the
 * snapshot; a test keeps the two from drifting.
 */
export const TOOLS = [
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

/**
 * The chat channel.
 *
 * These are only listed when the server was built with a channel, which is
 * every real entry point — `serve` and `mailmux mcp` both have one. A caller
 * that constructs the MCP server without one gets the mail tools and nothing
 * that would advertise a conversation it cannot hold.
 *
 * The descriptions carry the loop protocol because there is nowhere else to put
 * it. An agent reads these once and has to work out, unaided, that it should
 * keep calling `chat_await_message` rather than answer in its own terminal and
 * stop. Every sentence here is load-bearing; shortening them breaks the feature
 * in a way no type checks.
 */
const CHAT_LOOP = [
  "This is a LOOP, and you must keep running it until the user tells you to stop:",
  "call chat_await_message → do the work → chat_say the answer → call chat_await_message again.",
  "Never end your turn after answering once; go straight back to chat_await_message.",
].join(" ");

/** Exported with TOOLS for the connector snapshot — see TOOLS above. */
export const CHAT_TOOLS = [
  {
    name: "chat_await_message",
    description: `Wait for the user's next message in the mailmux window, and return it. ${CHAT_LOOP} A call that returns { "message": null, "timedOut": true } means nobody typed anything yet — that is normal and is NOT an error and NOT a reason to stop; call this tool again immediately. Anything the user typed before you started waiting is queued and comes back on the first call. Each message goes to exactly one agent, so do not run two agents against the same mailmux.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        timeoutSeconds: {
          type: "number",
          description: `How long to wait before returning { message: null }. Default ${DEFAULT_WAIT_MS / 1000}, maximum ${MAX_WAIT_MS / 1000}. Keep it below your own client's tool timeout.`,
          default: DEFAULT_WAIT_MS / 1000,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "chat_say",
    description: `Post a message to the user in the mailmux window. This is how the user reads your answer — text you write in your own terminal or chat client is NOT visible to them, so every answer to a chat_await_message has to go through here. Write it as a reply to a person: plain sentences, no tool-call transcripts, no JSON. ${CHAT_LOOP}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "What to say. Markdown is rendered.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "chat_activity",
    description:
      "Post a short status line — 'searching three mailboxes for the invoice', 'reading 12 messages' — while a request is taking a while. It renders as a quiet line, not as a message, so the user can see you are working instead of watching nothing happen. Optional, one short present-tense clause, and never a substitute for chat_say: an activity line is not an answer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "One short present-tense clause." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "chat_history",
    description:
      "Read recent turns of this conversation, oldest first. Use it to pick up context after you restart or lose your own history — the user expects you to remember what they already told you in this window.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", default: 50 },
      },
      additionalProperties: false,
    },
  },
];

const CHAT_TOOL_NAMES = new Set(CHAT_TOOLS.map((t) => t.name));

function toolsFor(channel?: AgentChannel) {
  return channel ? [...TOOLS, ...CHAT_TOOLS] : TOOLS;
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

export function createMcpServer(
  mail: MailService,
  channel?: AgentChannel,
): Server {
  const server = new Server(
    { name: "mailmux", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(channel),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await dispatch(mail, name, args, channel);
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
  channel?: AgentChannel,
): Promise<unknown> {
  if (CHAT_TOOL_NAMES.has(name)) {
    if (!channel) throw new Error(`${name} is not available on this server`);
    return dispatchChat(channel, name, args);
  }
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

/**
 * The chat tools.
 *
 * `chat_await_message` returns `{ message: null, timedOut: true }` rather than
 * throwing on a timeout. An error would show up in the agent's client as a
 * failed tool call, which is exactly the signal that makes a model stop and
 * apologise instead of calling again — and calling again is the entire
 * protocol. The hint is repeated in the payload because that is the last thing
 * the model reads before deciding what to do next.
 */
async function dispatchChat(
  channel: AgentChannel,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "chat_await_message": {
      const seconds = Number(args.timeoutSeconds ?? DEFAULT_WAIT_MS / 1000);
      const turn = await channel.awaitUserTurn({
        timeoutMs: Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_WAIT_MS,
      });
      if (!turn) {
        return {
          message: null,
          timedOut: true,
          hint: "Nobody typed anything yet. This is normal. Call chat_await_message again now.",
        };
      }
      return {
        message: { seq: turn.seq, at: turn.at, text: turn.text },
        hint: "Answer with chat_say, then call chat_await_message again.",
      };
    }
    case "chat_say": {
      const turn = channel.post({
        role: "agent",
        text: String(args.text ?? ""),
        agent: channel.clientName,
      });
      return {
        posted: true,
        seq: turn.seq,
        hint: "Delivered. Call chat_await_message again to keep the conversation open.",
      };
    }
    case "chat_activity": {
      const turn = channel.post({
        role: "activity",
        text: String(args.text ?? ""),
        agent: channel.clientName,
      });
      return { posted: true, seq: turn.seq };
    }
    case "chat_history": {
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
      const turns = channel.history().slice(-limit);
      return {
        turns: turns.map((t) => ({
          seq: t.seq,
          at: t.at,
          role: t.role,
          text: t.text,
        })),
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function runStdioMcp(
  mail: MailService,
  channel?: AgentChannel,
): Promise<void> {
  const server = createMcpServer(mail, channel);
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
  channel?: AgentChannel,
): Promise<unknown> {
  const id = message.id ?? null;
  if (message.method === "initialize") {
    const params = message.params as
      | { protocolVersion?: unknown; clientInfo?: { name?: unknown } }
      | undefined;
    const requested = params?.protocolVersion;
    // Best effort, for a presence label only. See AgentChannel.noteClient.
    const clientName = params?.clientInfo?.name;
    if (channel && typeof clientName === "string") {
      channel.noteClient(clientName);
    }
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
    return { jsonrpc: "2.0", id, result: { tools: toolsFor(channel) } };
  }
  if (message.method === "tools/call") {
    const params = message.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    const known =
      TOOL_NAMES.has(params.name) ||
      (channel !== undefined && CHAT_TOOL_NAMES.has(params.name));
    if (!known) {
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
        channel,
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

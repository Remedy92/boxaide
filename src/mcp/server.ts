import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentChannel } from "../agent/channel.js";
import type { ApprovalQueue } from "../agent/approvals.js";
import { needsApproval } from "../agent/approvals.js";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "../agent/channel.js";
import type { MailService } from "../mail/service.js";
import type { Platform } from "../platform.js";
import { CRM_TOOLS, CRM_TOOL_NAMES, dispatchCrmTool } from "../crm/tools.js";
import {
  AUTOMATION_TOOLS,
  AUTOMATION_TOOL_NAMES,
  dispatchAutomationTool,
} from "../automation/tools.js";
import {
  OUTREACH_TOOLS,
  OUTREACH_TOOL_NAMES,
  dispatchOutreachTool,
} from "../outreach/tools.js";
import {
  CALENDAR_TOOLS,
  CALENDAR_TOOL_NAMES,
  dispatchCalendarTool,
} from "../calendar/tools.js";
import {
  ENRICHMENT_TOOLS,
  ENRICHMENT_TOOL_NAMES,
  dispatchEnrichmentTool,
} from "../enrichment/tools.js";
import {
  RESEARCH_TOOLS,
  RESEARCH_TOOL_NAMES,
  dispatchResearchTool,
} from "../research/tools.js";
import {
  PROSPECTING_TOOLS,
  PROSPECTING_TOOL_NAMES,
  dispatchProspectingTool,
} from "../prospecting/tools.js";
import { parseAttachments, type DraftInput } from "../provider/types.js";
import { MAX_LIST_LIMIT, requireListLimit } from "../input-limits.js";
import {
  isScopeProfile,
  scopeAllows,
  scopeRefusal,
  type ScopeProfile,
} from "./scope.js";

/**
 * The platform tool surface, exported for the mcpb connector snapshot
 * (scripts/export-mcpb-tools.mjs) alongside TOOLS and CHAT_TOOLS.
 */
export const PLATFORM_TOOLS = [
  ...CRM_TOOLS,
  ...AUTOMATION_TOOLS,
  ...OUTREACH_TOOLS,
  ...CALENDAR_TOOLS,
  ...ENRICHMENT_TOOLS,
  ...RESEARCH_TOOLS,
  ...PROSPECTING_TOOLS,
];

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
      "List message summaries from one account (alias/id) or all accounts. Unified inbox when account is 'all'. Returns { messages, errors }; a non-empty errors array means some accounts failed and the list is incomplete. Without `since` this returns the newest `limit` messages and nothing older, so it CANNOT answer 'everything from the last day' on its own — pass `since` whenever you mean a period of time, and raise `limit` to cover the busiest expected day.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: {
          type: "string",
          description: "Account alias, id, or 'all'",
          default: "all",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          default: 25,
        },
        folder: {
          type: "string",
          description: "Folder path from folders_list.",
          default: "INBOX",
        },
        unreadOnly: { type: "boolean", default: false },
        since: {
          type: "string",
          description:
            "ISO timestamp. Returns only mail received at or after it. This is the only way to bound a read by time; a period written in prose is ignored.",
        },
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
        limit: {
          type: "number",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          default: 25,
        },
        since: {
          type: "string",
          description:
            "ISO timestamp. Narrows the search to mail received at or after it.",
        },
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
      "Deliver an email from a connected account. This is the explicit escalation, not the default: use draft_create instead unless the user has asked for the mail to be sent. To reply in-thread, set inReplyTo and references from the Message-ID header of the message you answer. If Boxaide launched you, this does not send: it puts the message in front of the user, who sends it or drops it — you will be told so, and you must not call it a second time for the same message.",
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
        attachments: {
          type: "array",
          description:
            "Optional list of files to attach. Each entry can be an object with { path, filename, contentType } or inline { filename, content, contentType, encoding }.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Local file path to attach.",
              },
              filename: {
                type: "string",
                description:
                  "Name for the attached file (defaults to filename of path).",
              },
              content: {
                type: "string",
                description: "Inline attachment content (text or base64).",
              },
              contentType: {
                type: "string",
                description:
                  "MIME type (e.g. application/pdf, text/plain). Inferred if omitted.",
              },
              encoding: {
                type: "string",
                description: "Encoding of content, e.g. 'base64' or 'utf-8'.",
              },
            },
            additionalProperties: false,
          },
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
    name: "message_archive",
    description:
      "File one message into the account's Archive mailbox. This is a move, not a delete: the result names the folder it came from (fromFolder) and the one it landed in (toFolder), and message_move puts it back. Returns { moved: false } when the message had already left that folder. Fails on an account whose server has no Archive mailbox.",
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
    name: "message_move",
    description:
      "Move one message into another mailbox of the same account. Use a path from folders_list. Nothing is sent. A move into Trash is how mail gets deleted on most servers, so this is the escalation of the pair: prefer message_archive, which files into the account's own Archive mailbox and needs no approval. A launched agent calling this does not move anything. The call is put in front of the user, who carries it out or drops it. The Drafts mailbox is off limits in both directions: drafts have their own tools. Returns { moved: false } when the message had already left its folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias or id." },
        messageId: { type: "string", description: MESSAGE_ID_DESC },
        folder: {
          type: "string",
          description: "Destination mailbox path, from folders_list.",
        },
      },
      required: ["account", "messageId", "folder"],
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
        attachments: {
          type: "array",
          description:
            "Optional list of files to attach. Each entry can be an object with { path, filename, contentType } or inline { filename, content, contentType, encoding }.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Local file path to attach.",
              },
              filename: {
                type: "string",
                description:
                  "Name for the attached file (defaults to filename of path).",
              },
              content: {
                type: "string",
                description: "Inline attachment content (text or base64).",
              },
              contentType: {
                type: "string",
                description:
                  "MIME type (e.g. application/pdf, text/plain). Inferred if omitted.",
              },
              encoding: {
                type: "string",
                description: "Encoding of content, e.g. 'base64' or 'utf-8'.",
              },
            },
            additionalProperties: false,
          },
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
        attachments: {
          type: "array",
          description:
            "Optional list of files to attach. Each entry can be an object with { path, filename, contentType } or inline { filename, content, contentType, encoding }.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Local file path to attach.",
              },
              filename: {
                type: "string",
                description:
                  "Name for the attached file (defaults to filename of path).",
              },
              content: {
                type: "string",
                description: "Inline attachment content (text or base64).",
              },
              contentType: {
                type: "string",
                description:
                  "MIME type (e.g. application/pdf, text/plain). Inferred if omitted.",
              },
              encoding: {
                type: "string",
                description: "Encoding of content, e.g. 'base64' or 'utf-8'.",
              },
            },
            additionalProperties: false,
          },
        },
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
        limit: {
          type: "number",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          default: 25,
        },
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
 * every real entry point — `serve` and `boxaide mcp` both have one. A caller
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
    description: `Wait for the user's next message in the Boxaide window, and return it. ${CHAT_LOOP} A call that returns { "message": null, "timedOut": true } means nobody typed anything yet — that is normal and is NOT an error and NOT a reason to stop; call this tool again immediately. Anything the user typed before you started waiting is queued and comes back on the first call. Each message goes to exactly one agent, so do not run two agents against the same Boxaide.`,
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
    description: `Post a message to the user in the Boxaide window. This is how the user reads your answer — text you write in your own terminal or chat client is NOT visible to them, so every answer to a chat_await_message has to go through here. Write it as a reply to a person: plain sentences, no tool-call transcripts, no JSON. ${CHAT_LOOP}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "What to say. Markdown is rendered.",
        },
        title: {
          type: "string",
          description:
            "A name for this conversation, four words or fewer, describing what it is about — 'Refund for the Acme invoice', not 'Email question'. Send it when the wait payload said needsTitle; it is ignored otherwise, and the name is only taken once, so write it for a list the user reads a week from now.",
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
        limit: {
          type: "number",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          default: 50,
        },
      },
      additionalProperties: false,
    },
  },
];

const CHAT_TOOL_NAMES = new Set(CHAT_TOOLS.map((t) => t.name));

/**
 * What this caller may see.
 *
 * `channel` and `platform` say what this server has to offer; `scope` says
 * what this caller is allowed to reach. Filtering the listing is a courtesy to
 * the model — it stops it planning around a tool it cannot call — and never
 * the enforcement: that is `dispatch`, which every path goes through.
 */
function toolsFor(
  channel?: AgentChannel,
  platform?: Platform,
  scope?: ScopeProfile | null,
) {
  const base = channel ? [...TOOLS, ...CHAT_TOOLS] : [...TOOLS];
  const all = platform ? [...base, ...PLATFORM_TOOLS] : base;
  return scope ? all.filter((tool) => scopeAllows(scope, tool.name)) : all;
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** Every tool a server with a platform offers, in one set. See tools/call. */
const PLATFORM_TOOL_NAMES = new Set(PLATFORM_TOOLS.map((t) => t.name));

export function createMcpServer(
  mail: MailService,
  channel?: AgentChannel,
  platform?: Platform,
  scope?: ScopeProfile | null,
  approvals?: ApprovalQueue,
): Server {
  const server = new Server(
    { name: "boxaide", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(channel, platform, scope),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await dispatch(
        mail,
        name,
        args,
        channel,
        platform,
        extra?.signal,
        scope,
        approvals,
      );
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
    attachments: parseAttachments(args.attachments),
  };
}

async function dispatch(
  mail: MailService,
  name: string,
  args: Record<string, unknown>,
  channel?: AgentChannel,
  platform?: Platform,
  signal?: AbortSignal,
  scope?: ScopeProfile | null,
  approvals?: ApprovalQueue,
): Promise<unknown> {
  // The enforcement point, ahead of every other check. Both transports and
  // every tool family reach the server through here, so a tool added to any
  // of them is refused by default for a scoped caller until scope.ts names it.
  if (scope && !scopeAllows(scope, name)) {
    throw new Error(scopeRefusal(scope, name));
  }
  // The second boundary, and the one that lets a launched agent have these
  // tools at all. A scoped caller reaching message_send, message_move,
  // meeting_create or meeting_cancel does not perform it: the call is recorded
  // and put in front of the user, who carries it out or drops it. See
  // src/agent/approvals.ts.
  //
  // Ahead of every dispatch below for the same reason the scope check is —
  // one gate, so a tool family added later cannot route around it. An
  // unscoped caller (the master bearer, the user's own desktop client) is the
  // user, and still sends directly.
  if (scope && needsApproval(name)) {
    if (!approvals) {
      throw new Error(
        `${name} needs a person to approve it, and this server has nowhere to ask. Draft the work instead.`,
      );
    }
    channel?.noteToolCall(name);
    return approvals.queue({
      tool: name,
      args,
      profile: scope,
      agent: channel?.presence().lastAgent ?? null,
      // A scheduled run has no conversation. Its request waits in the pane
      // with the rest and names the run instead of a chat.
      chatId: scope === "run" ? null : (channel?.activeChat().id ?? null),
    });
  }
  if (CHAT_TOOL_NAMES.has(name)) {
    if (!channel) throw new Error(`${name} is not available on this server`);
    return dispatchChat(channel, name, args, signal);
  }
  if (
    CRM_TOOL_NAMES.has(name) ||
    AUTOMATION_TOOL_NAMES.has(name) ||
    OUTREACH_TOOL_NAMES.has(name) ||
    CALENDAR_TOOL_NAMES.has(name) ||
    ENRICHMENT_TOOL_NAMES.has(name) ||
    RESEARCH_TOOL_NAMES.has(name) ||
    PROSPECTING_TOOL_NAMES.has(name)
  ) {
    if (!platform) throw new Error(`${name} is not available on this server`);
    channel?.noteToolCall(name);
    if (CRM_TOOL_NAMES.has(name)) return dispatchCrmTool(platform, name, args);
    if (AUTOMATION_TOOL_NAMES.has(name)) {
      return dispatchAutomationTool(platform, name, args);
    }
    if (CALENDAR_TOOL_NAMES.has(name)) {
      return dispatchCalendarTool(platform, name, args);
    }
    if (ENRICHMENT_TOOL_NAMES.has(name)) {
      return dispatchEnrichmentTool(platform, name, args);
    }
    if (PROSPECTING_TOOL_NAMES.has(name)) {
      return dispatchProspectingTool(platform, name, args);
    }
    if (RESEARCH_TOOL_NAMES.has(name)) {
      return dispatchResearchTool(platform, name, args);
    }
    return dispatchOutreachTool(platform, name, args);
  }
  // A mail tool call under an open question is a step the user can watch. The
  // channel keeps it only while a message is claimed — see noteToolCall.
  channel?.noteToolCall(name);
  switch (name) {
    case "accounts_list":
      return { accounts: mail.listAccounts() };
    case "messages_list": {
      const { messages, errors } = await mail.listMessages(
        String(args.account ?? "all"),
        {
          limit: requireListLimit(args.limit, 25),
          folder: args.folder ? String(args.folder) : undefined,
          unreadOnly: Boolean(args.unreadOnly),
          since: args.since ? String(args.since) : undefined,
        },
      );
      return errors.length ? { messages, errors } : { messages };
    }
    case "messages_search": {
      const { messages, errors } = await mail.searchMessages(
        String(args.account ?? "all"),
        {
          query: String(args.query ?? ""),
          limit: requireListLimit(args.limit, 25),
          since: args.since ? String(args.since) : undefined,
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
          attachments: parseAttachments(args.attachments),
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
    case "message_archive": {
      const result = await mail.archiveMessage(
        String(args.account),
        String(args.messageId),
      );
      // Only a launched agent's archives are written down, and only the ones
      // that happened. The user's own client is the user: they archived it on
      // purpose and have the toast's own undo. An agent working a list needs
      // one undo for the list, which is what this row feeds.
      if (scope && result.moved) {
        platform?.archiveLog?.record({
          accountId: mail.accountId(String(args.account)),
          messageId: result.id ?? null,
          fromFolder: result.fromFolder,
          toFolder: result.toFolder,
          agent: channel?.presence().lastAgent ?? null,
          chatId: scope === "run" ? null : (channel?.activeChat().id ?? null),
        });
      }
      return { result };
    }
    case "message_move":
      return {
        result: await mail.moveMessage(
          String(args.account),
          String(args.messageId),
          String(args.folder),
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
          limit: requireListLimit(args.limit, 25),
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
  signal?: AbortSignal,
): Promise<unknown> {
  switch (name) {
    case "chat_await_message": {
      // A driven conversation already has a loop; a second asker here would
      // present as the same holder and steal its lease. See AgentChannel.driven.
      if (channel.driven) {
        return {
          message: null,
          timedOut: true,
          hint: "Boxaide is handling this conversation for you. Do not call chat tools; just do the work you were asked.",
        };
      }
      const seconds = Number(args.timeoutSeconds ?? DEFAULT_WAIT_MS / 1000);
      const turn = await channel.awaitUserTurn({
        timeoutMs: Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_WAIT_MS,
        agent: channel.clientName,
        signal,
      });
      if (signal?.aborted) {
        if (turn) channel.releaseLease(turn.seq, { revertAttempt: true });
        return {
          message: null,
          timedOut: true,
          hint: "Nobody typed anything yet. This is normal. Call chat_await_message again now.",
        };
      }
      if (!turn) {
        return {
          message: null,
          timedOut: true,
          hint: "Nobody typed anything yet. This is normal. Call chat_await_message again now.",
        };
      }
      const redelivered = turn.deliveryCount > 1;
      // The chat is carrying the user's first line as its name until an agent
      // offers a better one. Asked for here rather than in the tool
      // description, because this is the payload read just before answering.
      const needsTitle = channel.needsTitle(turn.chatId);
      const answer = redelivered
        ? "You were handed this message before and did not chat_say. Answer with chat_say, then call chat_await_message again."
        : "Answer with chat_say, then call chat_await_message again.";
      return {
        message: { seq: turn.seq, at: turn.at, text: turn.text },
        redelivered,
        needsTitle,
        hint: needsTitle
          ? `${answer} This conversation has no name yet: pass a short "title" to chat_say saying what it is about.`
          : answer,
      };
    }
    case "chat_say": {
      if (channel.driven) {
        return {
          posted: false,
          hint: "Boxaide posts your reply for you in this conversation. Return your answer as normal output instead.",
        };
      }
      const turn = channel.post({
        role: "agent",
        text: String(args.text ?? ""),
        agent: channel.clientName,
      });
      // Offered, and refused without complaint when the chat already has a name
      // the user chose. A rejected title is not a failed answer.
      if (typeof args.title === "string") {
        channel.nameChat(turn.chatId, args.title);
      }
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
      const limit = requireListLimit(args.limit, 50);
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

/**
 * The stdio server, for a client the user wired up themselves.
 *
 * Unrestricted by default: this process is started by the user's own desktop
 * client, under their account, and narrowing it would silently break the
 * connector they already have. BOXAIDE_SCOPE narrows it for anyone who wants
 * the same boundary a launched agent gets.
 */
export async function runStdioMcp(
  mail: MailService,
  channel?: AgentChannel,
  platform?: Platform,
  env: NodeJS.ProcessEnv = process.env,
  approvals?: ApprovalQueue,
): Promise<void> {
  const requested = env.BOXAIDE_SCOPE;
  if (requested && !isScopeProfile(requested)) {
    throw new Error(
      `BOXAIDE_SCOPE must be one of chat, driven, run — got ${requested}`,
    );
  }
  const scope = isScopeProfile(requested) ? requested : null;
  const server = createMcpServer(mail, channel, platform, scope, approvals);
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
  platform?: Platform,
  signal?: AbortSignal,
  scope?: ScopeProfile | null,
  approvals?: ApprovalQueue,
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
        serverInfo: { name: "boxaide", version: "0.1.0" },
      },
    };
  }
  if (message.method === "notifications/initialized") {
    return null;
  }
  if (message.method === "notifications/cancelled") {
    return null;
  }
  if (message.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: toolsFor(channel, platform, scope) },
    };
  }
  if (message.method === "tools/call") {
    const params = message.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    // Derived from PLATFORM_TOOLS rather than listed family by family: this
    // check and toolsFor() must agree, and a hand-written list drifted the
    // moment enrichment and research were added — both were advertised by
    // tools/list and then refused here as unknown.
    const known =
      TOOL_NAMES.has(params.name) ||
      (channel !== undefined && CHAT_TOOL_NAMES.has(params.name)) ||
      (platform !== undefined && PLATFORM_TOOL_NAMES.has(params.name));
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
        platform,
        signal,
        scope,
        approvals,
      );
      if (signal?.aborted) return null;
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

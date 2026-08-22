/**
 * Actions an agent may ask for but never perform on its own.
 *
 * Sending mail, putting a meeting in somebody's calendar, and calling one off
 * are the three things an agent does that another person sees at once, and it
 * decides to do them after reading text that strangers wrote. Before this,
 * that risk was answered by taking the tools away — which also took away the
 * product: an inbox agent that cannot send mail writes drafts.
 *
 * So the tools come back, and the answer to the risk is a person. A scoped
 * agent calling one of them does not send anything; it queues the exact call
 * here and is told so. Boxaide carries it out when the user approves it, and
 * drops it when they do not.
 *
 * Two properties fall out of queueing rather than blocking, and both matter:
 *
 *  - A scheduled run at three in the morning can ask. Nobody is awake to
 *    answer, the run ends, and the request is waiting in the window in the
 *    morning. A blocking prompt would have to fail instead.
 *  - Nothing depends on the asking agent still being alive. The row holds the
 *    arguments, so approval replays the call through the same dispatch the
 *    agent would have reached — there is no second implementation of sending
 *    that could drift from the first.
 */
import { randomUUID } from "node:crypto";
import type { Store, StoredApproval } from "../db/store.js";
import type { MailService } from "../mail/service.js";
import { parseAttachments } from "../provider/types.js";
import type { Platform } from "../platform.js";
import type { AgentChannel } from "./channel.js";
import { dispatchCalendarTool, CALENDAR_SEND_TOOL_NAMES } from "../calendar/tools.js";

export type { StoredApproval };

/**
 * The tools that are queued instead of run.
 *
 * Hand-written, and checked against the calendar module's own set below, for
 * the reason `scope.ts` writes its tool list out: a tool added to the server
 * must not become something an agent can fire at a stranger because nobody
 * remembered this file.
 */
export const APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "message_send",
  "meeting_create",
  "meeting_cancel",
  // The odd one out: nobody else sees a move, so it is not here for the
  // stranger's sake. It is here because the destination is a free-text folder
  // and Trash is a folder — a move is the only way an agent can make mail
  // disappear, and on Gmail the server empties Trash 30 days later. Archiving
  // is not queued: it files into one mailbox the account itself names, and
  // moving it back is the undo.
  "message_move",
]);

export function needsApproval(tool: string): boolean {
  return APPROVAL_TOOL_NAMES.has(tool);
}

/** What the pane draws. Derived from the row, never stored beside it. */
export type ApprovalView = {
  id: string;
  tool: string;
  /** One line: what will happen if the user says yes. */
  title: string;
  /** The parts of the action worth reading before deciding. */
  fields: { label: string; value: string }[];
  /** The message body, when there is one. Shown in full, not truncated. */
  body: string | null;
  profile: string;
  agent: string | null;
  chatId: string | null;
  askedAt: string;
};

/**
 * Longest a queued list may grow before the oldest are refused.
 *
 * A launched agent that misreads its instructions can call `message_send` in a
 * loop, and every call would otherwise become a card the user has to dismiss
 * by hand. Past this the tool starts refusing, which is also the signal the
 * model needs: it is not being throttled, it is being told to stop.
 */
export const MAX_PENDING = 25;

export class ApprovalQueue {
  private listeners = new Set<() => void>();

  constructor(
    private store: Store,
    private deps: {
      mail: MailService;
      platform?: Platform;
      channel?: AgentChannel;
    },
  ) {}

  /* ---- asking ----------------------------------------------------------- */

  /**
   * Records a request and returns what the agent is told.
   *
   * The text is written for a model that will read it and decide what to do
   * next: it says the call was accepted, that a human now has it, and not to
   * try again. A model told only "denied" retries with different wording.
   */
  queue(input: {
    tool: string;
    args: Record<string, unknown>;
    profile: string;
    agent: string | null;
    chatId: string | null;
  }): { queued: true; approvalId: string; status: string } {
    const waiting = this.store.listApprovals({ pendingOnly: true, limit: MAX_PENDING + 1 });
    if (waiting.length >= MAX_PENDING) {
      throw new Error(
        `${input.tool} was not queued: ${MAX_PENDING} actions are already waiting for the user to approve them. Stop asking and tell the user what is waiting.`,
      );
    }
    const row = this.store.addApproval({
      id: randomUUID(),
      tool: input.tool,
      args: input.args,
      // Captured now, while the message is still where the agent found it.
      context: this.contextFor(input.tool, input.args),
      profile: input.profile,
      agent: input.agent,
      chatId: input.chatId,
      askedAt: new Date().toISOString(),
    });
    // The user is looking at the conversation, not at a queue. The line lands
    // in the transcript where they are already reading, and an agent that
    // re-reads its own history sees it too.
    this.note(row, `Waiting for you to approve: ${describe(row).title}`);
    this.changed();
    return {
      queued: true,
      approvalId: row.id,
      status: `${input.tool} needs the user's approval and has been put in front of them in the Boxaide window. Nothing has been sent. Do not call it again for this action and do not work around it — tell the user it is waiting, then carry on with something else or stop.`,
    };
  }

  /* ---- deciding --------------------------------------------------------- */

  pending(): ApprovalView[] {
    return this.store
      .listApprovals({ pendingOnly: true, limit: MAX_PENDING })
      .map((row) => describe(row));
  }

  get(id: string): StoredApproval | null {
    return this.store.getApproval(id);
  }

  /**
   * Carries out a request, or drops it.
   *
   * The claim comes first: `settleApproval` moves the row out of `pending` and
   * returns false if it was already claimed, so two windows racing on the same
   * card cannot both send the mail. The failure path then writes the row again
   * with what went wrong — an SMTP error must not leave a card that looks like
   * it was never touched, because the next click would send it twice.
   */
  async decide(
    id: string,
    decision: "approve" | "deny",
  ): Promise<{ state: StoredApproval["state"]; outcome: string }> {
    const row = this.store.getApproval(id);
    if (!row) throw new ApprovalError(404, "no such request");
    if (row.state !== "pending") {
      throw new ApprovalError(409, `that request was already ${row.state}`);
    }
    const at = new Date().toISOString();
    if (decision === "deny") {
      if (!this.store.settleApproval(id, "denied", "You declined it.", at)) {
        throw new ApprovalError(409, "that request was already decided");
      }
      this.note(row, `Declined: ${describe(row).title}`);
      this.changed();
      return { state: "denied", outcome: "You declined it." };
    }
    if (!this.store.settleApproval(id, "approved", null, at)) {
      throw new ApprovalError(409, "that request was already decided");
    }
    this.changed();
    try {
      await this.perform(row);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // Out of `pending` already — the claim above took it there — so this is
      // a plain write. A guarded one would match nothing and leave the row
      // reading "approved" for a send that never happened.
      this.forceState(id, "failed", why, at);
      this.note(row, `Could not carry out: ${describe(row).title} — ${why}`);
      this.changed();
      throw new ApprovalError(502, why);
    }
    this.forceState(id, "approved", "Done.", at);
    this.note(row, `Approved and done: ${describe(row).title}`);
    this.changed();
    return { state: "approved", outcome: "Done." };
  }

  /**
   * The approved call, run through the same dispatch the agent would have
   * reached. Nothing here re-implements sending; a change to how mail goes out
   * changes this path with it.
   */
  private async perform(row: StoredApproval): Promise<void> {
    const args = row.args;
    if (row.tool === "message_send") {
      await this.deps.mail.sendMessage(String(args.account), {
        to: String(args.to),
        subject: String(args.subject),
        text: String(args.text),
        html: args.html ? String(args.html) : undefined,
        cc: args.cc ? String(args.cc) : undefined,
        bcc: args.bcc ? String(args.bcc) : undefined,
        inReplyTo: args.inReplyTo ? String(args.inReplyTo) : undefined,
        references: args.references ? String(args.references) : undefined,
        attachments: parseAttachments(args.attachments),
      });
      return;
    }
    if (row.tool === "message_move") {
      const result = await this.deps.mail.moveMessage(
        String(args.account),
        String(args.messageId),
        String(args.folder),
      );
      // A queued move is carried out whenever the user gets to it, which may
      // be hours after it was asked for. By then the message may have been
      // moved by hand in another client, and `moveMessage` reports that by
      // returning rather than throwing. Say so: a card that reads "Done." for
      // a move that did not happen is the one lie this queue must not tell.
      if (!result.moved) {
        throw new Error(
          `the message is no longer in ${result.fromFolder}, so nothing was moved`,
        );
      }
      return;
    }
    if (CALENDAR_SEND_TOOL_NAMES.has(row.tool)) {
      if (!this.deps.platform) {
        throw new Error(`${row.tool} is not available on this server`);
      }
      await dispatchCalendarTool(this.deps.platform, row.tool, args);
      return;
    }
    throw new Error(`${row.tool} cannot be carried out`);
  }

  /**
   * `settleApproval` only writes rows still in `pending`, which is exactly
   * what the claim above needs and exactly what the outcome write cannot use.
   * This is the second write, and it is deliberately not a second guarded one.
   */
  private forceState(
    id: string,
    state: StoredApproval["state"],
    outcome: string,
    at: string,
  ): void {
    this.store.db
      .prepare(`UPDATE agent_approvals SET state = ?, outcome = ?, decided_at = ? WHERE id = ?`)
      .run(state, outcome, at, id);
  }

  /**
   * What the card needs beyond the arguments, per tool.
   *
   * Only message_move has any: it names its message by an opaque
   * accountId:folder:uid id, and nobody can judge "move this to Trash" from
   * one. Read from the local index, so an unindexed message simply yields
   * nothing and the card falls back to the id.
   */
  private contextFor(
    tool: string,
    args: Record<string, unknown>,
  ): StoredApproval["context"] {
    if (tool !== "message_move") return null;
    const account = args.account;
    const messageId = args.messageId;
    if (typeof account !== "string" || typeof messageId !== "string") {
      return null;
    }
    return this.deps.mail.describeMessage(account, messageId);
  }

  /* ---- watching --------------------------------------------------------- */

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * A line in the conversation the request came from.
   *
   * `activity` rather than `agent`: this is Boxaide narrating, not the model
   * answering, and posting it as an answer would end the lease on whatever
   * question the agent is still working through.
   */
  private note(row: StoredApproval, text: string): void {
    if (!row.chatId || !this.deps.channel) return;
    if (!this.deps.channel.writable(row.chatId)) return;
    this.deps.channel.post({
      role: "activity",
      text,
      agent: row.agent,
      chatId: row.chatId,
    });
  }
}

export class ApprovalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/**
 * The card's text, built from the arguments every time it is asked for.
 *
 * Deliberately not stored next to the row. A summary written once and kept is
 * a second copy of the action that can disagree with the arguments actually
 * replayed on approval, and the whole point of the card is that the user is
 * looking at what will happen.
 */
export function describe(row: StoredApproval): ApprovalView {
  const args = row.args;
  const text = (key: string): string | null => {
    const value = args[key];
    if (value === undefined || value === null) return null;
    const out = String(value).trim();
    return out.length > 0 ? out : null;
  };
  const fields: { label: string; value: string }[] = [];
  let title: string;
  let body: string | null = null;

  if (row.tool === "message_send") {
    const to = text("to") ?? "nobody named";
    const subject = text("subject") ?? "(no subject)";
    title = `Send “${subject}” to ${to}`;
    push(fields, "From", text("account"));
    push(fields, "To", to);
    push(fields, "Cc", text("cc"));
    push(fields, "Bcc", text("bcc"));
    push(fields, "Subject", subject);
    const attachments = parseAttachments(args.attachments);
    if (attachments && attachments.length > 0) {
      const labels = attachments.map(
        (a) => a.filename || a.path || "attachment",
      );
      push(fields, "Attachments", labels.join(", "));
    }
    body = text("text") ?? text("html");
  } else if (row.tool === "meeting_create") {
    const attendees = list(args.attendees);
    title = `Create “${text("title") ?? "(untitled)"}” and invite ${
      attendees.length > 0 ? attendees.join(", ") : "nobody"
    }`;
    push(fields, "Starts", text("start"));
    push(fields, "Ends", text("end"));
    push(fields, "Invites", attendees.join(", ") || null);
    push(fields, "Location", text("location"));
    body = text("description");
  } else if (row.tool === "message_move") {
    const folder = text("folder") ?? "(no folder named)";
    // The subject when the agent asked, not the id. A card the user cannot
    // read is a click they cannot make responsibly, and this one can end with
    // mail in Trash.
    const subject = row.context?.subject?.trim();
    title = subject
      ? `Move “${subject}” to ${folder}`
      : `Move a message to ${folder}`;
    push(fields, "Account", text("account"));
    push(fields, "From", row.context?.from ?? null);
    push(fields, "Subject", subject ?? null);
    push(fields, "Now in", row.context?.folder ?? null);
    push(fields, "Into", folder);
    // Only when there was nothing better to say: an id is not something a
    // person reads, but it beats naming no message at all.
    if (!subject) push(fields, "Message", text("messageId"));
  } else if (row.tool === "meeting_cancel") {
    title = "Cancel a meeting and tell everyone invited";
    push(fields, "Meeting", text("meetingId"));
  } else {
    title = row.tool;
  }

  return {
    id: row.id,
    tool: row.tool,
    title,
    fields,
    body,
    profile: row.profile,
    agent: row.agent,
    chatId: row.chatId,
    askedAt: row.askedAt,
  };
}

function push(
  fields: { label: string; value: string }[],
  label: string,
  value: string | null,
): void {
  if (value) fields.push({ label, value });
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

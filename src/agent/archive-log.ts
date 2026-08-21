/**
 * What a launched agent archived, and the one control that puts it back.
 *
 * Archiving is the only mail write an agent performs without asking, and the
 * argument for letting it is that a move is reversible. That argument only
 * holds if a person can actually reverse it. An agent told to tidy an inbox
 * files messages one call at a time, and the web UI's per-message Undo — a
 * toast, in a window nobody is watching while the agent works — is not an
 * answer to three hundred of them.
 *
 * So every archive a scoped caller performs is written down, and consecutive
 * archives by the same agent in the same conversation are read back as one
 * sweep the user can undo in a single click.
 *
 * Grouping is done here rather than stamped on the row, because there is no
 * run id to stamp: the MCP dispatch knows the agent name and the chat, and a
 * scheduled run has neither a chat nor an end it announces. Two archives more
 * than SWEEP_GAP_MS apart are therefore two sweeps, which is the same rule a
 * person would apply reading the list.
 */
import type { Store, AgentArchiveRow } from "../db/store.js";
import type { MailService } from "../mail/service.js";

/** Longer than a slow IMAP round trip, shorter than a coffee. */
export const SWEEP_GAP_MS = 5 * 60_000;

/** Rows older than this are dropped when the log is read. */
export const ARCHIVE_LOG_TTL_MS = 7 * 24 * 60 * 60_000;

export type ArchiveSweep = {
  /** The first row's id. Stable for as long as the sweep is undoable. */
  id: number;
  agent: string | null;
  chatId: string | null;
  /** Everything the agent archived in this sweep. */
  count: number;
  /**
   * How many of those can be moved back. Lower than `count` on a server
   * without UIDPLUS, which archives without naming the message's new id.
   */
  undoable: number;
  firstAt: string;
  lastAt: string;
};

function sameRun(a: AgentArchiveRow, b: AgentArchiveRow): boolean {
  if (a.agent !== b.agent || a.chatId !== b.chatId) return false;
  const gap = Date.parse(b.at) - Date.parse(a.at);
  return Number.isFinite(gap) && gap <= SWEEP_GAP_MS;
}

export class ArchiveLog {
  constructor(
    private store: Store,
    private mail: MailService,
  ) {}

  /**
   * Writing the row is the whole job, and it never throws: a failure to record
   * an archive must not fail the archive itself.
   */
  record(input: {
    accountId: string;
    messageId: string | null;
    fromFolder: string;
    toFolder: string;
    agent: string | null;
    chatId: string | null;
    now?: number;
  }): void {
    try {
      this.store.addAgentArchive({
        accountId: input.accountId,
        messageId: input.messageId,
        fromFolder: input.fromFolder,
        toFolder: input.toFolder,
        agent: input.agent,
        chatId: input.chatId,
        at: new Date(input.now ?? Date.now()).toISOString(),
      });
    } catch {
      // An archive that happened is more important than a row about it.
    }
  }

  /** Newest sweep first, which is the one a user is most likely to want back. */
  sweeps(now = Date.now()): ArchiveSweep[] {
    this.store.pruneAgentArchives(
      new Date(now - ARCHIVE_LOG_TTL_MS).toISOString(),
    );
    const rows = this.store.listAgentArchives();
    const out: ArchiveSweep[] = [];
    let current: AgentArchiveRow[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const first = current[0];
      const last = current[current.length - 1];
      out.push({
        id: first.id,
        agent: first.agent,
        chatId: first.chatId,
        count: current.length,
        undoable: current.filter((r) => r.messageId != null).length,
        firstAt: first.at,
        lastAt: last.at,
      });
      current = [];
    };
    for (const row of rows) {
      if (current.length > 0 && !sameRun(current[current.length - 1], row)) {
        flush();
      }
      current.push(row);
    }
    flush();
    return out.reverse();
  }

  /**
   * Move a whole sweep back where it came from.
   *
   * Every message is attempted, and one that cannot be moved does not stop the
   * rest: by the time somebody clicks this, the mail has been sitting in the
   * Archive mailbox where any other client could have touched it. The counts
   * are what actually happened. A row is forgotten once there is nothing left
   * to do with it — moved back, moved elsewhere by somebody, or archived with
   * no id to move back to — so the sweep cannot be undone twice and cannot
   * leave behind a card whose only button does nothing.
   */
  async undo(sweepId: number): Promise<{ restored: number; failed: number }> {
    const rows = this.store.listAgentArchives();
    const start = rows.findIndex((r) => r.id === sweepId);
    if (start < 0) throw new Error("that sweep is no longer on record");
    const sweep: AgentArchiveRow[] = [rows[start]];
    for (let i = start + 1; i < rows.length; i += 1) {
      if (!sameRun(sweep[sweep.length - 1], rows[i])) break;
      sweep.push(rows[i]);
    }

    let restored = 0;
    let failed = 0;
    const done: number[] = [];
    for (const row of sweep) {
      if (!row.messageId) {
        // Never had an id to move back to, and never will: the server did not
        // name one when it moved the message. Counted as failed and forgotten,
        // because leaving it would keep drawing a card whose only button does
        // nothing.
        failed += 1;
        done.push(row.id);
        continue;
      }
      try {
        const result = await this.mail.moveMessage(
          row.accountId,
          row.messageId,
          row.fromFolder,
        );
        if (result.moved) {
          restored += 1;
          done.push(row.id);
        } else {
          // Already somewhere else. Nothing to put back, and nothing to keep
          // offering: the row goes with the rest.
          failed += 1;
          done.push(row.id);
        }
      } catch {
        // Kept, unlike the two cases above: a move that threw may have thrown
        // because the server was briefly unreachable, and that is worth
        // offering again.
        failed += 1;
      }
    }
    this.store.deleteAgentArchives(done);
    return { restored, failed };
  }
}

import { randomBytes } from "node:crypto";
import addressparser from "nodemailer/lib/addressparser/index.js";
import type { Store } from "../db/store.js";
import { canonicalEmail } from "../outreach/opt-out.js";
import { MailIndexStore } from "./index-store.js";
import type {
  AccountCredentials,
  DraftInput,
  DraftRef,
  ListDraftsOpts,
  ListMessagesOpts,
  MailDraft,
  MailFolder,
  MailMessage,
  MailMessageSummary,
  MailProvider,
  MoveResult,
  ProviderAccount,
  SearchMessagesOpts,
  SendMessageInput,
  SendResult,
} from "../provider/types.js";

export type ConnectAccountInput = {
  alias: string;
  email: string;
  creds: AccountCredentials;
};

/**
 * Result of a fan-out read. `messages` holds everything that came back;
 * `errors` holds one entry per account that failed, keyed by alias.
 * A single unreachable mailbox no longer fails the whole unified inbox,
 * so callers MUST read `.messages` (never the return value itself) and
 * should surface `.errors` to the user.
 */
export type MessageListResult = {
  messages: MailMessageSummary[];
  errors: Array<{ account: string; error: string }>;
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Veto hook run before every send. The platform (src/platform.ts) installs a
 * guard that throws on suppressed recipients; `override` is the human's
 * explicit "send anyway" and only the REST send route can set it.
 */
export type SendGuard = (recipients: string[], override: boolean) => void;

export class MailService {
  private sendGuard: SendGuard | null = null;
  readonly index: MailIndexStore;
  private inflight = new Map<string, Promise<void>>();
  private unwatch = new Map<string, () => void>();
  private idleOn = false;

  constructor(
    private store: Store,
    private provider: MailProvider,
  ) {
    this.index = new MailIndexStore(store.db, store.masterKey);
  }

  setSendGuard(guard: SendGuard): void {
    this.sendGuard = guard;
  }

  /**
   * Keep INBOX in IDLE for every connected account. Serve-only: stdio MCP
   * must not hold IMAP sessions open.
   */
  start(): void {
    this.idleOn = true;
    for (const a of this.store.listAccounts()) {
      try {
        this.watchAccount(this.resolve(a.id));
      } catch (err) {
        console.warn(
          `[mail] failed to start watcher for ${a.alias} (${a.email}):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  stop(): void {
    this.idleOn = false;
    for (const unsub of this.unwatch.values()) unsub();
    this.unwatch.clear();
  }

  listAccounts() {
    return this.store.listAccounts();
  }

  /**
   * One account with its stored password decrypted.
   *
   * Public because the calendar can reuse a mailbox's own credentials for
   * CalDAV at the providers where the two are the same login (see
   * src/calendar/mailbox-reuse.ts). It stays a narrow accessor rather than a
   * handle on the Store: the caller gets one named account or an exception,
   * never a way to walk every secret in the database.
   */
  accountWithCredentials(idOrAlias: string): ProviderAccount {
    return this.resolve(idOrAlias);
  }

  async connectAccount(input: ConnectAccountInput) {
    const alias = input.alias.trim().toLowerCase().replace(/\s+/g, "-");
    if (!alias) throw new Error("alias is required");
    if (!input.email.includes("@")) throw new Error("valid email is required");

    const test = await this.provider.testConnection(input.creds);
    if (!test.ok) {
      throw new Error(test.error ?? "connection test failed");
    }

    const existing = this.store.getAccount(alias);
    const id = existing?.id ?? randomBytes(8).toString("hex");
    this.store.upsertAccount({
      id,
      alias,
      email: input.email.trim(),
      creds: input.creds,
    });
    const account = this.resolve(id);
    if (this.idleOn) this.watchAccount(account);
    return { id, alias, email: input.email.trim() };
  }

  removeAccount(idOrAlias: string): boolean {
    const existing = this.store.getAccount(idOrAlias);
    if (existing) {
      this.unwatch.get(existing.id)?.();
      this.unwatch.delete(existing.id);
      this.index.deleteAccount(existing.id);
    }
    return this.store.deleteAccount(idOrAlias);
  }

  private resolve(idOrAlias: string): ProviderAccount {
    const account = this.store.getAccount(idOrAlias);
    if (!account) throw new Error(`account not found: ${idOrAlias}`);
    return {
      id: account.id,
      alias: account.alias,
      email: account.email,
      creds: this.store.credentialsFor(account),
    };
  }

  /** Fan out across every account, keeping whatever succeeds. */
  private async fanOut(
    fetch: (account: ProviderAccount) => Promise<MailMessageSummary[]>,
    limit: number,
  ): Promise<MessageListResult> {
    const accounts = this.store.listAccounts();
    const settled = await Promise.allSettled(
      accounts.map(async (a) => fetch(this.resolve(a.id))),
    );
    const messages: MailMessageSummary[] = [];
    const errors: Array<{ account: string; error: string }> = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") messages.push(...res.value);
      else errors.push({ account: accounts[i].alias, error: errText(res.reason) });
    });
    messages.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
    return { messages: messages.slice(0, limit), errors };
  }

  /**
   * Returns { messages, errors } — NOT a bare array. With accountRef "all",
   * unreachable accounts land in `errors` and the rest still return.
   *
   * After the first fill, this is a SQLite read. IMAP runs only when the
   * folder is empty, shorter than the requested window, dirty, or stale.
   */
  async listMessages(
    accountRef: string | "all",
    opts: ListMessagesOpts = {},
  ): Promise<MessageListResult> {
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    const accounts =
      accountRef === "all"
        ? this.store.listAccounts()
        : [this.store.getAccount(accountRef)].filter(
            (a): a is NonNullable<typeof a> => a != null,
          );
    if (accountRef !== "all" && accounts.length === 0) {
      throw new Error(`account not found: ${accountRef}`);
    }

    const errors: Array<{ account: string; error: string }> = [];
    // ensureFresh hands back the state it already loaded, so the lastError
    // sweep below does not re-run the same mailbox_state query per account.
    const lastErrors = await Promise.all(
      accounts.map(async (row) => {
        try {
          return await this.ensureFresh(
            row.id,
            folder,
            limit,
            opts.refresh === true,
            opts.since,
          );
        } catch (err) {
          this.index.setLastError(row.id, folder, errText(err));
          if (accountRef !== "all") throw err;
          errors.push({ account: row.alias, error: errText(err) });
          return null;
        }
      }),
    );

    accounts.forEach((row, i) => {
      const last = lastErrors[i];
      if (last && !errors.some((e) => e.account === row.alias)) {
        errors.push({ account: row.alias, error: last });
      }
    });

    return {
      messages: this.index.listMessages({
        accountIds: accounts.map((a) => a.id),
        folder,
        limit,
        offset: opts.offset,
        unreadOnly: opts.unreadOnly,
        since: opts.since,
      }),
      errors,
    };
  }

  /**
   * Returns { messages, errors } — NOT a bare array. With accountRef "all",
   * unreachable accounts land in `errors` and the rest still return.
   */
  async searchMessages(
    accountRef: string | "all",
    opts: SearchMessagesOpts,
  ): Promise<MessageListResult> {
    if (accountRef === "all") {
      return this.fanOut(
        (account) => this.provider.searchMessages(account, opts),
        opts.limit ?? 50,
      );
    }
    const account = this.resolve(accountRef);
    return {
      messages: await this.provider.searchMessages(account, opts),
      errors: [],
    };
  }

  async getMessage(
    accountRef: string,
    messageId: string,
    folder?: string,
  ): Promise<MailMessage | null> {
    return this.provider.getMessage(this.resolve(accountRef), messageId, folder);
  }

  async sendMessage(
    accountRef: string,
    input: SendMessageInput,
    opts: { overrideSuppression?: boolean } = {},
  ): Promise<SendResult> {
    // Fail closed before any parsing, guard installed or not. A non-string
    // recipient (an unvalidated REST body can post {name, address}) parses to
    // address "" and would leave the guard with nothing to check while
    // nodemailer still delivered it. Rejecting here also keeps the provider
    // from ever seeing a shape it was not typed for.
    if (
      typeof input.to !== "string" ||
      (input.cc !== undefined && typeof input.cc !== "string") ||
      (input.bcc !== undefined && typeof input.bcc !== "string")
    ) {
      throw new Error("invalid recipients: to/cc/bcc must be strings");
    }
    if (this.sendGuard) {
      // Nodemailer's own parser, so the guard sees exactly the addresses
      // nodemailer would deliver to. A hand-rolled comma split missed
      // semicolon-separated lists and RFC 2822 group syntax
      // ("team: a@x.com, b@y.com;") — forms nodemailer delivers happily,
      // which made them suppression bypasses. flatten unwraps groups.
      // canonicalEmail (not trim+lowercase) because nodemailer punycodes IDN
      // domains: the unicode and punycode spellings are one mailbox and must
      // hit one suppression key.
      const recipients = [input.to, input.cc, input.bcc]
        .filter((v): v is string => Boolean(v))
        .flatMap((v) => addressparser(v, { flatten: true }))
        .map((entry) => canonicalEmail(entry.address))
        .filter((v) => v.includes("@"));
      this.sendGuard(recipients, opts.overrideSuppression === true);
    }
    const account = this.resolve(accountRef);
    const result = await this.provider.sendMessage(account, input);
    if (result.copied) this.index.upsertSummary(result.copied);
    else if (result.sentFolder) {
      this.index.markDirty(account.id, result.sentFolder);
    }
    return result;
  }

  async markRead(
    accountRef: string,
    messageId: string,
    seen: boolean,
  ): Promise<boolean> {
    const account = this.resolve(accountRef);
    const ok = await this.provider.markRead(account, messageId, seen);
    if (ok) this.index.setSeen(account.id, messageId, seen);
    return ok;
  }

  /**
   * File one message into the account's Archive mailbox.
   *
   * Nothing is deleted: archiving is a move, and `fromFolder` in the result is
   * what an undo moves it back to. A server with no Archive mailbox throws —
   * see MailProvider.archiveMessage for why that is not guessed at.
   */
  async archiveMessage(
    accountRef: string,
    messageId: string,
  ): Promise<MoveResult> {
    const account = this.resolve(accountRef);
    const result = await this.provider.archiveMessage(account, messageId);
    this.applyMove(account.id, messageId, result);
    return result;
  }

  /**
   * File one message into the account's Trash mailbox.
   *
   * Delete means this and nothing else: no \Deleted flag and no expunge, so
   * the message is still there to be moved back and `fromFolder` in the result
   * says where back is. A server with no Trash mailbox throws, for the same
   * reason a missing Archive mailbox does.
   */
  async trashMessage(
    accountRef: string,
    messageId: string,
  ): Promise<MoveResult> {
    const account = this.resolve(accountRef);
    const result = await this.provider.trashMessage(account, messageId);
    this.applyMove(account.id, messageId, result);
    return result;
  }

  /** Move one message to a named mailbox. The undo of an archive goes here. */
  async moveMessage(
    accountRef: string,
    messageId: string,
    folder: string,
  ): Promise<MoveResult> {
    if (!folder.trim()) throw new Error("folder is required");
    // ImapFlow's compiler already refuses CR/LF/NUL in a mailbox name, but
    // with a wire-level "Unquotable character" error. Refuse here with a
    // sentence the toast can show.
    if (/[\0\r\n]/.test(folder)) {
      throw new Error("folder name contains control characters");
    }
    const account = this.resolve(accountRef);
    const result = await this.provider.moveMessage(account, messageId, folder);
    this.applyMove(account.id, messageId, result);
    return result;
  }

  /**
   * Keep the index in step with a move that already happened on the server:
   * the row leaves the folder it was in, and the folder it landed in is marked
   * for a refresh rather than having a row fabricated into it — only the server
   * knows the uid the message now has there.
   */
  private applyMove(
    accountId: string,
    messageId: string,
    result: MoveResult,
  ): void {
    if (!result.moved) return;
    this.index.removeMessage(accountId, messageId);
    this.index.markDirty(accountId, result.toFolder);
  }

  /** The account id behind an alias or id. Throws when neither names one. */
  accountId(accountRef: string): string {
    return this.resolve(accountRef).id;
  }

  /**
   * What a message is, in the terms a person judges it by, from the local
   * index alone. Null when it was never indexed.
   *
   * No IMAP: the caller is the approval card, which is drawn while the user
   * waits and may be drawn for a message that has since moved.
   */
  describeMessage(
    accountRef: string,
    messageId: string,
  ): { subject: string; from: string; folder: string } | null {
    let accountId: string;
    try {
      accountId = this.resolve(accountRef).id;
    } catch {
      return null;
    }
    const summary = this.index.getSummary(accountId, messageId);
    if (!summary) return null;
    return {
      subject: summary.subject,
      from: summary.from,
      folder: summary.folder,
    };
  }

  async listFolders(accountRef: string): Promise<MailFolder[]> {
    return this.provider.listFolders(this.resolve(accountRef));
  }

  /**
   * Draft writes are per-account only — there is no "all" fan-out. A draft
   * belongs to exactly one mailbox, and guessing which would be a send-adjacent
   * decision made on the user's behalf.
   */
  async createDraft(
    accountRef: string,
    input: DraftInput,
  ): Promise<DraftRef> {
    return this.provider.createDraft(this.resolve(accountRef), input);
  }

  /** Returns a NEW draft id; the one passed in is dead afterwards. */
  async updateDraft(
    accountRef: string,
    draftId: string,
    input: DraftInput,
  ): Promise<DraftRef> {
    return this.provider.updateDraft(this.resolve(accountRef), draftId, input);
  }

  async listDrafts(
    accountRef: string,
    opts: ListDraftsOpts = {},
  ): Promise<MailDraft[]> {
    return this.provider.listDrafts(this.resolve(accountRef), opts);
  }

  async deleteDraft(accountRef: string, draftId: string): Promise<boolean> {
    return this.provider.deleteDraft(this.resolve(accountRef), draftId);
  }

  async testCredentials(
    creds: AccountCredentials,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.provider.testConnection(creds);
  }

  private watchAccount(account: ProviderAccount): void {
    if (!this.provider.watchMailbox) return;
    this.unwatch.get(account.id)?.();
    const unsub = this.provider.watchMailbox(account, "INBOX", () => {
      this.index.markDirty(account.id, "INBOX");
      void this.syncFolder(account, "INBOX", 50).catch((err) => {
        this.index.setLastError(account.id, "INBOX", errText(err));
      });
    });
    this.unwatch.set(account.id, unsub);
  }

  /**
   * Empty or short window: wait for IMAP. Warm cache: return immediately and
   * refresh in the background when dirty or older than 30s.
   *
   * Returns the folder's standing `lastError` so the caller does not re-read
   * the state row it just loaded here.
   *
   * Takes an account id, not a resolved ProviderAccount: resolving costs an
   * accounts row read and an AES-GCM decrypt of the IMAP password, and the warm
   * path never opens a connection. The decrypt happens only in the branches
   * that actually reach IMAP.
   */
  private async ensureFresh(
    accountId: string,
    folder: string,
    limit: number,
    force = false,
    since?: string,
  ): Promise<string | null> {
    const state = this.index.getState(accountId, folder);
    const refreshLater = () => {
      if (!state?.dirty && !this.index.isStale(state)) return;
      void this.syncFolder(this.resolve(accountId), folder, limit).catch(
        (err) => {
          this.index.setLastError(accountId, folder, errText(err));
        },
      );
    };
    /** The error standing after an awaited sync, which may have cleared it. */
    const settled = () => this.index.getState(accountId, folder)?.lastError ?? null;
    // A dated ask is not a window ask, so the window rules below do not apply
    // to it: holding the newest `limit` rows says nothing about whether the
    // index reaches back to the instant the caller named. Fill by date once,
    // then answer from SQLite for as long as that coverage stands.
    if (since) {
      if (this.index.needsSinceFill(state, since)) {
        await this.syncFolder(this.resolve(accountId), folder, limit, { since });
        return settled();
      }
      refreshLater();
      return state?.lastError ?? null;
    }
    // Bounded: the question is only whether the index already holds `limit`
    // rows, and an exact count of a 20k-message Archive walks 20k rows to
    // answer it.
    const count = this.index.count(accountId, folder, limit);
    const exists = state?.exists ?? 0;
    const needsFill =
      count === 0 || (count < limit && exists > 0 && count < exists);
    if (force || needsFill) {
      await this.syncFolder(this.resolve(accountId), folder, limit, {
        fullWindow: needsFill,
      });
      return settled();
    }
    refreshLater();
    return state?.lastError ?? null;
  }

  private async syncFolder(
    account: ProviderAccount,
    folder: string,
    limit: number,
    opts: { fullWindow?: boolean; since?: string } = {},
  ): Promise<void> {
    // A dated read answers a different question than a window read, so the
    // two must not collapse into one another's in-flight promise.
    const key = `${account.id}:${folder}:${opts.since ?? ""}`;
    const existing = this.inflight.get(key);
    if (existing) {
      await existing;
      if (!opts.fullWindow) return;
      const count = this.index.count(account.id, folder);
      if (count >= limit) return;
    }
    const run = (async () => {
      const state = this.index.getState(account.id, folder);
      const result = await this.provider.syncMailbox(account, {
        folder,
        limit,
        since: opts.since,
        fullWindow: opts.fullWindow,
        knownUids: this.index.listUids(account.id, folder),
        cursor: state
          ? {
              uidvalidity: state.uidvalidity,
              highestModseq: state.highestModseq,
              uidnext: state.uidnext,
              exists: state.exists,
            }
          : null,
      });
      this.index.applySync(account.id, folder, result);
    })().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }
}

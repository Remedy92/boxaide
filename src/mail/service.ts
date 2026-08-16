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
    await Promise.all(
      accounts.map(async (row) => {
        try {
          const account = this.resolve(row.id);
          await this.ensureFresh(account, folder, limit, opts.refresh === true);
        } catch (err) {
          this.index.setLastError(row.id, folder, errText(err));
          if (accountRef !== "all") throw err;
          errors.push({ account: row.alias, error: errText(err) });
        }
      }),
    );

    for (const row of accounts) {
      const last = this.index.getState(row.id, folder)?.lastError;
      if (last && !errors.some((e) => e.account === row.alias)) {
        errors.push({ account: row.alias, error: last });
      }
    }

    return {
      messages: this.index.listMessages({
        accountIds: accounts.map((a) => a.id),
        folder,
        limit,
        offset: opts.offset,
        unreadOnly: opts.unreadOnly,
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
   */
  private async ensureFresh(
    account: ProviderAccount,
    folder: string,
    limit: number,
    force = false,
  ): Promise<void> {
    const state = this.index.getState(account.id, folder);
    const count = this.index.count(account.id, folder);
    const exists = state?.exists ?? 0;
    const needsFill =
      count === 0 || (count < limit && exists > 0 && count < exists);
    if (force || needsFill) {
      await this.syncFolder(account, folder, limit, { fullWindow: needsFill });
      return;
    }
    if (state?.dirty || this.index.isStale(state)) {
      void this.syncFolder(account, folder, limit).catch((err) => {
        this.index.setLastError(account.id, folder, errText(err));
      });
    }
  }

  private async syncFolder(
    account: ProviderAccount,
    folder: string,
    limit: number,
    opts: { fullWindow?: boolean } = {},
  ): Promise<void> {
    const key = `${account.id}:${folder}`;
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

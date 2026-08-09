import { randomBytes } from "node:crypto";
import type { Store } from "../db/store.js";
import type {
  AccountCredentials,
  ListMessagesOpts,
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

export class MailService {
  constructor(
    private store: Store,
    private provider: MailProvider,
  ) {}

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
    return { id, alias, email: input.email.trim() };
  }

  removeAccount(idOrAlias: string): boolean {
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
   */
  async listMessages(
    accountRef: string | "all",
    opts: ListMessagesOpts = {},
  ): Promise<MessageListResult> {
    if (accountRef === "all") {
      return this.fanOut(
        (account) => this.provider.listMessages(account, opts),
        opts.limit ?? 50,
      );
    }
    const account = this.resolve(accountRef);
    return {
      messages: await this.provider.listMessages(account, opts),
      errors: [],
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
  ): Promise<SendResult> {
    return this.provider.sendMessage(this.resolve(accountRef), input);
  }

  async markRead(
    accountRef: string,
    messageId: string,
    seen: boolean,
  ): Promise<boolean> {
    return this.provider.markRead(this.resolve(accountRef), messageId, seen);
  }

  async listFolders(accountRef: string): Promise<MailFolder[]> {
    return this.provider.listFolders(this.resolve(accountRef));
  }

  async testCredentials(
    creds: AccountCredentials,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.provider.testConnection(creds);
  }
}

import { randomBytes } from "node:crypto";
import type { Store } from "../db/store.js";
import type {
  AccountCredentials,
  ListMessagesOpts,
  MailMessage,
  MailMessageSummary,
  MailProvider,
  SearchMessagesOpts,
  SendMessageInput,
  SendResult,
} from "../provider/types.js";

export type ConnectAccountInput = {
  alias: string;
  email: string;
  creds: AccountCredentials;
};

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

  private resolve(idOrAlias: string) {
    const account = this.store.getAccount(idOrAlias);
    if (!account) throw new Error(`account not found: ${idOrAlias}`);
    const creds = this.store.credentialsFor(account);
    return { account, creds };
  }

  async listMessages(
    accountRef: string | "all",
    opts: ListMessagesOpts = {},
  ): Promise<MailMessageSummary[]> {
    if (accountRef === "all") {
      const accounts = this.store.listAccounts();
      const batches = await Promise.all(
        accounts.map(async (a) => {
          const { creds } = this.resolve(a.id);
          return this.provider.listMessages(a.id, creds, opts);
        }),
      );
      return batches
        .flat()
        .sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        )
        .slice(0, opts.limit ?? 50);
    }
    const { account, creds } = this.resolve(accountRef);
    return this.provider.listMessages(account.id, creds, opts);
  }

  async searchMessages(
    accountRef: string | "all",
    opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]> {
    if (accountRef === "all") {
      const accounts = this.store.listAccounts();
      const batches = await Promise.all(
        accounts.map(async (a) => {
          const { creds } = this.resolve(a.id);
          return this.provider.searchMessages(a.id, creds, opts);
        }),
      );
      return batches
        .flat()
        .sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        )
        .slice(0, opts.limit ?? 50);
    }
    const { account, creds } = this.resolve(accountRef);
    return this.provider.searchMessages(account.id, creds, opts);
  }

  async getMessage(
    accountRef: string,
    messageId: string,
    folder?: string,
  ): Promise<MailMessage | null> {
    const { account, creds } = this.resolve(accountRef);
    return this.provider.getMessage(account.id, creds, messageId, folder);
  }

  async sendMessage(
    accountRef: string,
    input: SendMessageInput,
  ): Promise<SendResult> {
    const { account, creds } = this.resolve(accountRef);
    return this.provider.sendMessage(account.id, creds, input);
  }

  async testCredentials(
    creds: AccountCredentials,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.provider.testConnection(creds);
  }
}

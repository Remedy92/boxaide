import Database from "better-sqlite3";
import { join } from "node:path";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";
import type { AccountCredentials, MailAuth } from "../provider/types.js";

export type StoredAccount = {
  id: string;
  alias: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: number;
  username: string;
  /** Encrypted password (password auth) or access token (xoauth2). */
  passwordEnc: string;
  /** `password` (default) or `xoauth2`. */
  authKind: string;
  createdAt: string;
};

export class Store {
  readonly db: Database.Database;

  constructor(
    private masterKey: Buffer,
    dbPath: string | ":memory:",
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  static open(dataDir: string, masterKey: Buffer): Store {
    return new Store(masterKey, join(dataDir, "mailmux.db"));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL,
        imap_secure INTEGER NOT NULL,
        smtp_host TEXT NOT NULL,
        smtp_port INTEGER NOT NULL,
        smtp_secure INTEGER NOT NULL,
        username TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        auth_kind TEXT NOT NULL DEFAULT 'password',
        created_at TEXT NOT NULL
      );
    `);
    // Only reached by databases created before auth_kind existed. Fresh ones
    // get the column from the CREATE above, so this is a no-op for them.
    const cols = this.db
      .prepare(`PRAGMA table_info(accounts)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "auth_kind")) {
      this.db.exec(
        `ALTER TABLE accounts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'password'`,
      );
    }
  }

  listAccounts(): Array<{
    id: string;
    alias: string;
    email: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, alias, email, created_at as createdAt FROM accounts ORDER BY created_at ASC`,
      )
      .all() as Array<{
      id: string;
      alias: string;
      email: string;
      createdAt: string;
    }>;
    return rows;
  }

  getAccount(idOrAlias: string): StoredAccount | null {
    const row = this.db
      .prepare(
        `SELECT id, alias, email,
          imap_host as imapHost, imap_port as imapPort, imap_secure as imapSecure,
          smtp_host as smtpHost, smtp_port as smtpPort, smtp_secure as smtpSecure,
          username, password_enc as passwordEnc,
          COALESCE(auth_kind, 'password') as authKind,
          created_at as createdAt
         FROM accounts WHERE id = ? OR alias = ?`,
      )
      .get(idOrAlias, idOrAlias) as StoredAccount | undefined;
    return row ?? null;
  }

  credentialsFor(account: StoredAccount): AccountCredentials {
    const secret = decryptSecret(this.masterKey, account.passwordEnc);
    const auth: MailAuth =
      account.authKind === "xoauth2"
        ? { kind: "xoauth2", user: account.username, accessToken: secret }
        : { kind: "password", user: account.username, pass: secret };
    return {
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecure: Boolean(account.imapSecure),
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecure: Boolean(account.smtpSecure),
      auth,
    };
  }

  upsertAccount(input: {
    id: string;
    alias: string;
    email: string;
    creds: AccountCredentials;
  }): void {
    const { auth } = input.creds;
    const secret = auth.kind === "password" ? auth.pass : auth.accessToken;
    const passwordEnc = encryptSecret(this.masterKey, secret);
    const authKind = auth.kind;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO accounts (
          id, alias, email, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, username, password_enc, auth_kind, created_at
        ) VALUES (
          @id, @alias, @email, @imapHost, @imapPort, @imapSecure,
          @smtpHost, @smtpPort, @smtpSecure, @username, @passwordEnc, @authKind, @createdAt
        )
        ON CONFLICT(id) DO UPDATE SET
          alias=excluded.alias,
          email=excluded.email,
          imap_host=excluded.imap_host,
          imap_port=excluded.imap_port,
          imap_secure=excluded.imap_secure,
          smtp_host=excluded.smtp_host,
          smtp_port=excluded.smtp_port,
          smtp_secure=excluded.smtp_secure,
          username=excluded.username,
          password_enc=excluded.password_enc,
          auth_kind=excluded.auth_kind
        `,
      )
      .run({
        id: input.id,
        alias: input.alias,
        email: input.email,
        imapHost: input.creds.imapHost,
        imapPort: input.creds.imapPort,
        imapSecure: input.creds.imapSecure ? 1 : 0,
        smtpHost: input.creds.smtpHost,
        smtpPort: input.creds.smtpPort,
        smtpSecure: input.creds.smtpSecure ? 1 : 0,
        username: auth.user,
        passwordEnc,
        authKind,
        createdAt,
      });
  }

  deleteAccount(idOrAlias: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM accounts WHERE id = ? OR alias = ?`)
      .run(idOrAlias, idOrAlias);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

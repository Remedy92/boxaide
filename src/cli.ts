#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { envFirst, loadConfig } from "./config.js";
import { createRuntime, startServer } from "./app.js";
import { tokenLine } from "./cli-output.js";
import { runStdioMcp } from "./mcp/server.js";
import { FixtureProvider } from "./provider/fixture.js";
import { Store } from "./db/store.js";

async function main(): Promise<void> {
  const [cmd = "serve", ...rest] = process.argv.slice(2);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "serve") {
    const fixture =
      rest.includes("--fixture") || envFirst("SLEY_FIXTURE", "MAILMUX_FIXTURE") === "1";
    const { runtime, stop } = await startServer({ fixtureMode: fixture });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void stop().then(() => process.exit(0));
      });
    }
    // Seed demo accounts in fixture mode for first-run UX
    if (fixture && runtime.provider instanceof FixtureProvider) {
      await seedFixtureDemo(runtime.mail, runtime.provider, runtime.store);
    }
    const { host, port, dataDir, bearerToken } = runtime.config;
    console.log(`sley listening on http://${host}:${port}`);
    console.log(`data dir: ${dataDir}`);
    console.log(tokenLine(bearerToken, dataDir));
    console.log(`MCP HTTP: POST http://${host}:${port}/mcp  (Authorization: Bearer <token>)`);
    console.log(`stdio MCP: sley mcp`);
    if (fixture) console.log("fixture mode: demo mailboxes seeded");
    return;
  }

  if (cmd === "mcp") {
    const config = loadConfig({
      fixtureMode: envFirst("SLEY_FIXTURE", "MAILMUX_FIXTURE") === "1",
    });
    const runtime = createRuntime(config);
    if (
      config.fixtureMode &&
      runtime.provider instanceof FixtureProvider &&
      runtime.mail.listAccounts().length === 0
    ) {
      await seedFixtureDemo(runtime.mail, runtime.provider, runtime.store);
    }
    // stdio: no console.log on stdout
    await runStdioMcp(runtime.mail, runtime.channel);
    return;
  }

  if (cmd === "init") {
    const config = loadConfig();
    const envExample = join(config.dataDir, "env.example");
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(
      envExample,
      `# sley\nSLEY_DATA_DIR=${config.dataDir}\nSLEY_HOST=127.0.0.1\nSLEY_PORT=8787\n# SLEY_TOKEN=\n# SLEY_MASTER_KEY=\n# SLEY_FIXTURE=1\n`,
    );
    console.log(`Initialized data dir: ${config.dataDir}`);
    console.log(tokenLine(config.bearerToken, config.dataDir));
    console.log(`Wrote ${envExample}`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

async function seedFixtureDemo(
  mail: import("./mail/service.js").MailService,
  provider: FixtureProvider,
  _store: Store,
): Promise<void> {
  if (mail.listAccounts().length > 0) return;

  const personal = await mail.connectAccount({
    alias: "personal",
    email: "you@personal.test",
    creds: {
      imapHost: "fixture",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "fixture",
      smtpPort: 465,
      smtpSecure: true,
      auth: {
        kind: "password",
        user: "you@personal.test",
        pass: "fixture",
      },
    },
  });
  const work = await mail.connectAccount({
    alias: "work",
    email: "you@work.test",
    creds: {
      imapHost: "fixture",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "fixture",
      smtpPort: 465,
      smtpSecure: true,
      auth: { kind: "password", user: "you@work.test", pass: "fixture" },
    },
  });

  provider.seedAccount(personal.id, "you@personal.test", [
    {
      subject: "Flight confirmation NYC",
      from: "airlines@example.com",
      bodyText: "Your flight to Boston is on Tuesday 9am.",
      seen: false,
    },
    {
      subject: "Receipt #9841",
      from: "billing@shop.test",
      bodyText: "You paid $42.00 for headphones.",
      seen: true,
    },
  ]);
  provider.seedAccount(work.id, "you@work.test", [
    {
      subject: "Q3 roadmap review",
      from: "ceo@work.test",
      bodyText: "Please review the attached roadmap before Friday.",
      seen: false,
    },
    {
      subject: "Invoice from Acme",
      from: "ap@acme.test",
      bodyText: "Invoice INV-220 is due next week.",
      seen: false,
    },
  ]);
}

function printHelp(): void {
  console.log(`sley — free multi-mailbox agentic inbox

Usage:
  sley serve [--fixture]   Start web UI + API + MCP HTTP
  sley mcp                 stdio MCP server for agents
  sley init                Create data dir + print token
  sley help

Env:
  SLEY_DATA_DIR     default ~/.sley (or ~/.mailmux if that exists and ~/.sley does not)
  SLEY_HOST         default 127.0.0.1
  SLEY_PORT         default 8787
  SLEY_TOKEN        API/MCP bearer token
  SLEY_MASTER_KEY   secret encryption key (64 hex chars preferred; any
                    other value is a passphrase, stretched with scrypt)
  SLEY_FIXTURE=1    use in-memory demo mailboxes (no real IMAP)
  MAILMUX_*         still read when the matching SLEY_* is unset
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

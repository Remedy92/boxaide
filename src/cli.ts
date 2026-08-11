#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createRuntime, startServer } from "./app.js";
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
    const fixture = rest.includes("--fixture") || process.env.MAILMUX_FIXTURE === "1";
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
    console.log(`mailmux listening on http://${host}:${port}`);
    console.log(`data dir: ${dataDir}`);
    console.log(`bearer token: ${bearerToken}`);
    console.log(`MCP HTTP: POST http://${host}:${port}/mcp  (Authorization: Bearer <token>)`);
    console.log(`stdio MCP: mailmux mcp`);
    if (fixture) console.log("fixture mode: demo mailboxes seeded");
    return;
  }

  if (cmd === "mcp") {
    const config = loadConfig({
      fixtureMode: process.env.MAILMUX_FIXTURE === "1",
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
      `# mailmux\nMAILMUX_DATA_DIR=${config.dataDir}\nMAILMUX_HOST=127.0.0.1\nMAILMUX_PORT=8787\n# MAILMUX_TOKEN=\n# MAILMUX_MASTER_KEY=\n# MAILMUX_FIXTURE=1\n`,
    );
    console.log(`Initialized data dir: ${config.dataDir}`);
    console.log(`Bearer token: ${config.bearerToken}`);
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
  console.log(`mailmux — free multi-mailbox agentic inbox

Usage:
  mailmux serve [--fixture]   Start web UI + API + MCP HTTP
  mailmux mcp                 stdio MCP server for agents
  mailmux init                Create data dir + print token
  mailmux help

Env:
  MAILMUX_DATA_DIR   default ~/.mailmux
  MAILMUX_HOST       default 127.0.0.1
  MAILMUX_PORT       default 8787
  MAILMUX_TOKEN      API/MCP bearer token
  MAILMUX_MASTER_KEY secret encryption key (hex 64 or passphrase)
  MAILMUX_FIXTURE=1  use in-memory demo mailboxes (no real IMAP)
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

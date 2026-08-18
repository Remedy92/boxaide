#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { envNamed, loadConfig } from "./config.js";
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
      rest.includes("--fixture") || envNamed("FIXTURE") === "1";
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
    console.log(`boxaide listening on http://${host}:${port}`);
    console.log(`data dir: ${dataDir}`);
    console.log(tokenLine(bearerToken, dataDir));
    console.log(`MCP HTTP: POST http://${host}:${port}/mcp  (Authorization: Bearer <token>)`);
    console.log(`stdio MCP: boxaide mcp`);
    if (fixture) console.log("fixture mode: demo mailboxes seeded");
    return;
  }

  if (cmd === "mcp") {
    const config = loadConfig({
      fixtureMode: envNamed("FIXTURE") === "1",
    });
    const runtime = createRuntime(config);
    if (
      config.fixtureMode &&
      runtime.provider instanceof FixtureProvider &&
      runtime.mail.listAccounts().length === 0
    ) {
      await seedFixtureDemo(runtime.mail, runtime.provider, runtime.store);
    }
    // stdio: no console.log on stdout. Platform tools included; platform
    // timers deliberately NOT started — the serve process owns those.
    await runStdioMcp(
      runtime.mail,
      runtime.channel,
      runtime.platform,
      process.env,
      runtime.approvals,
    );
    return;
  }

  if (cmd === "init") {
    const config = loadConfig();
    const envExample = join(config.dataDir, "env.example");
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(
      envExample,
      `# boxaide\nBOXAIDE_DATA_DIR=${config.dataDir}\nBOXAIDE_HOST=127.0.0.1\nBOXAIDE_PORT=8787\n# BOXAIDE_TOKEN=\n# BOXAIDE_MASTER_KEY=\n# BOXAIDE_FIXTURE=1\n`,
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
      subject: "Weekly digest — now with pictures",
      from: "newsletter@example.com",
      bodyText: "Your weekly digest. View this mail in an HTML client to see the charts.",
      // Exercises the HTML reading path: an inline data: image (renders
      // immediately, like a cid: attachment after mailparser inlines it) and
      // a remote image (blocked until "Load images").
      bodyHtml: [
        '<div style="font-family: Georgia, serif; max-width: 480px">',
        "<h1 style=\"color: #1a4d8f\">Weekly digest</h1>",
        "<p>The inline chart below always renders; the remote photo waits for your say-so.</p>",
        '<img alt="Inline chart" src="data:image/svg+xml;base64,',
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><rect width="480" height="120" fill="#e8f0fe"/><rect x="20" y="60" width="60" height="40" fill="#1a4d8f"/><rect x="100" y="40" width="60" height="60" fill="#4a7bbf"/><rect x="180" y="20" width="60" height="80" fill="#1a4d8f"/><text x="260" y="70" font-family="sans-serif" font-size="16" fill="#1a4d8f">inline image</text></svg>',
        ).toString("base64"),
        '">',
        '<p><img alt="Remote photo" src="https://picsum.photos/480/160" width="480" height="160"></p>',
        '<p><a href="https://example.com">Read the full story</a></p>',
        "</div>",
      ].join(""),
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
  console.log(`boxaide — free multi-mailbox agentic inbox

Usage:
  boxaide serve [--fixture]   Start web UI + API + MCP HTTP
  boxaide mcp                 stdio MCP server for agents
  boxaide init                Create data dir + print token
  boxaide help

Env:
  BOXAIDE_DATA_DIR     default ~/.boxaide (then ~/.sley, then ~/.mailmux)
  BOXAIDE_HOST         default 127.0.0.1
  BOXAIDE_PORT         default 8787
  BOXAIDE_TOKEN        API/MCP bearer token
  BOXAIDE_MASTER_KEY   secret encryption key (64 hex chars preferred; any
                    other value is a passphrase, stretched with scrypt)
  BOXAIDE_FIXTURE=1    use in-memory demo mailboxes (no real IMAP)
  SLEY_* / MAILMUX_*   still read when the matching BOXAIDE_* is unset
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

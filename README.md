# mailmux

**Free, self-hosted multi-mailbox agentic inbox.**  
Connect any IMAP/SMTP mail. One unified inbox in the browser. One MCP surface for every agent.

No paid SaaS required for core receive + send. MIT licensed.

## Quick start

```bash
cd Projects/mailmux   # or your clone path
npm install
./scripts/start.sh --fixture
# equivalent: npm run dev -- --fixture
```

Open **http://127.0.0.1:8787** — on localhost the UI auto-loads the bearer token.

Fixture mode seeds two demo mailboxes (`personal`, `work`) so you can try the UI and MCP without real credentials.

### Real mail

```bash
npm run dev
```

In the UI: **Connect mailbox** → pick a preset (Gmail / Fastmail / Outlook / iCloud) or enter IMAP/SMTP hosts → use an **app password** where required.

### Production-ish start

```bash
npm run build
npm start
# or: node dist/cli.js serve
```

## Agent MCP (any client)

### HTTP MCP (Cursor / remote-capable clients)

```json
{
  "mcpServers": {
    "mailmux": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

Token lives in `~/.mailmux/bearer.token` (or `MAILMUX_TOKEN`).

### stdio MCP (Claude Desktop / Claude Code)

```bash
npm run mcp
# or: npx tsx src/cli.ts mcp
```

```json
{
  "mcpServers": {
    "mailmux": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mailmux/src/cli.ts", "mcp"],
      "env": {
        "MAILMUX_DATA_DIR": "/Users/you/.mailmux"
      }
    }
  }
}
```

### Tools

| Tool | Purpose |
|------|---------|
| `accounts_list` | Connected aliases |
| `messages_list` | Inbox list (`account`: alias or `all`) |
| `messages_search` | Free-text search |
| `message_get` | Full body |
| `message_send` | Send (confirm in your agent) |

Accounts are connected once in the web UI (or API). Agents reuse the same store — **no per-agent OAuth**.

## Install options

| Method | Command |
|--------|---------|
| Dev | `npm install && npm run dev` |
| Fixture demo | `npm run dev -- --fixture` |
| Built | `npm run build && npm start` |
| Init data dir | `npx tsx src/cli.ts init` |

### Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAILMUX_DATA_DIR` | `~/.mailmux` | SQLite + keys |
| `MAILMUX_HOST` | `127.0.0.1` | Bind address |
| `MAILMUX_PORT` | `8787` | Port |
| `MAILMUX_TOKEN` | auto file | API/MCP bearer |
| `MAILMUX_MASTER_KEY` | auto file | AES key for passwords |
| `MAILMUX_FIXTURE` | off | Demo provider |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

One Node process:

- `/` — web UI  
- `/api/*` — REST (same mail core)  
- `/mcp` — JSON-RPC MCP  
- `mailmux mcp` — stdio MCP  

IMAP via **ImapFlow**, SMTP via **Nodemailer**, secrets **AES-256-GCM**, state **SQLite**.

## Tests

```bash
npm test
```

Tests call **shipped** `MailService`, crypto, HTTP app, and MCP handlers with an in-memory **FixtureProvider** — no live mail accounts required.

## Security notes

- Default bind is localhost.
- Passwords encrypted at rest; master key in `~/.mailmux/master.key` (mode 0600).
- Prefer app passwords over primary account passwords.
- Keep `message_send` behind agent confirmation.

## License

MIT — free to use, modify, and redistribute.

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

## Using the hosted interface

mailmux ships two web interfaces. The bundled one at `/` is served by your own process. The newer one lives in `apps/web` — a Next.js static export — and you can run it either way. Both talk to the mailmux server on **your** machine, and neither sends your mail or your token anywhere else.

### Local (recommended — works in every browser)

```bash
npm run web:build   # npm ci + next build inside apps/web
npm run web:sync    # copy apps/web/out -> web-next/
npm start
```

`mailmux serve` prefers `web-next/` when it exists and falls back to the bundled `web/`. Open the URL it prints, normally `http://127.0.0.1:8787`. Same origin as the API, so nothing else is needed.

To run it on its own during development:

```bash
cd apps/web && npm install && npm run dev     # http://localhost:3000
cd apps/web && npm run build && npm run serve # the real static export
```

### Hosted (deployed somewhere else)

The page runs entirely in your browser and fetches mail directly from your machine.

**1. Deploy `apps/web`.** On Vercel and equivalents, set the project's **Root Directory** to `apps/web` and leave the build and output commands on auto. That setting is what keeps the CLI's `better-sqlite3` out of the front-end install; it lives in the dashboard and cannot be expressed in a file. Do **not** add a `workspaces` key to the root `package.json`.

No environment variable is required. One optional, non-secret variable exists:

| Name | Value | Purpose |
|---|---|---|
| `NEXT_PUBLIC_DEFAULT_API_BASE` | `http://127.0.0.1:8787` | The pre-filled Server URL on a browser with nothing in localStorage. Public by definition — it is inlined into the bundle at build time. Omit it and the same default comes from `apps/web/src/lib/constants.ts`. |

**2. Allow the origin.** On **your** machine, not on the host:

```bash
MAILMUX_ALLOWED_ORIGINS=https://your-deployment.example.com mailmux serve
```

See the rules and the cost of doing this under [Browser origins](#browser-origins-mailmux_allowed_origins) below.

**3. Copy the token.** `mailmux serve` prints it on first run; it is also in `bearer.token` inside your data directory (`~/.mailmux` by default).

**4. Point the page at your server.** Open the deployed page, click **Set up mailmux**, and enter the Server URL and the token. Both are stored in your browser's localStorage and are sent only to the server URL you entered.

**5. Allow local network access (Chrome, Edge, Brave).** Since Chromium 142 the browser asks permission before a website may reach `127.0.0.1`. Allow it when prompted; if you dismissed the prompt, re-enable it under Site settings → *Apps on device*.

### Safari, and the mixed-content limit

A page served over `https` cannot reach an `http` address. For `127.0.0.1` and `localhost` Chromium and Firefox make an exception; **WebKit does not**, and there is no workaround ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934), still open). This is also why `MAILMUX_ALLOWED_ORIGINS` drops `http://` entries: the configuration that would avoid the block is the one that makes the allowlist spoofable.

If your server is not on loopback, put it behind `https` or reach it over a tunnel. Otherwise use the local build — run `mailmux serve` and open `http://127.0.0.1:8787` directly. It is the same interface.

### What the host can see

Nothing. The deployed page has no server-side code: no API routes, no server actions, no proxy, no middleware. Your token, your mail credentials and every message body travel only between your browser and your own machine.

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
| `MAILMUX_ALLOWED_ORIGINS` | empty | Extra browser origins allowed to call the API — see below |

### Browser origins (`MAILMUX_ALLOWED_ORIGINS`)

By default mailmux accepts browser requests **only from your own machine**. A page on any other origin gets `403 {"error":"forbidden origin"}`. Leave the variable unset and nothing changes.

Set it when you want a web interface hosted somewhere else — a deployment of `apps/web`, for example — to talk to your local server. The page still runs entirely in your browser and still fetches mail directly from your machine; the variable only tells your server which page origins it will answer. See [Using the hosted interface](#using-the-hosted-interface) for the full walkthrough.

```bash
MAILMUX_ALLOWED_ORIGINS=https://your-deployment.example.com mailmux serve
```

Rules:

- Comma-separated, exact origins. `https://a.example.com,https://b.example.com`.
- Only `https://` entries are kept. A plaintext origin is trivially spoofed on a hostile network, so `http://` entries are dropped.
- Path, query and case are stripped: `https://A.App/x` becomes `https://a.app`. A port must match exactly — `https://a.app` does not allow `https://a.app:8443`.
- **`*` is ignored on purpose.** mailmux holds your mail credentials; an any-origin allowlist would let any page you visit probe your server.
- Loopback (`127.0.0.1`, `localhost`, `::1`) always passes, so the bundled UI needs no configuration.
- Requests with no `Origin` header (curl, MCP clients) are unaffected.

**What enabling this costs you.** The origin check is the last defence-in-depth layer in front of a service that holds decrypted IMAP passwords. Adding an origin means:

- Anyone who can serve a page at that exact hostname can reach your server **if they also have your bearer token**. On shared hosting platforms that includes preview deployments and anyone with deploy access. Prefer a custom domain you control over a platform-assigned hostname.
- It is the only remaining barrier against a DNS-rebinding page reaching your loopback service, so the list should stay as short as you can make it.
- The token is still required on every request. `Access-Control-Allow-Credentials` is never sent — mailmux authenticates by header, never by cookie — so no page can ride ambient credentials.
- `/api/local-bootstrap`, which hands out the bearer token in plaintext, is **not** widened by this variable. It stays loopback-only. A remote page must have its token pasted in by a human.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

One Node process:

- `/` — web UI (`web-next/` when the `apps/web` export has been synced, otherwise the bundled `web/`)  
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
- Browser requests are loopback-only unless `MAILMUX_ALLOWED_ORIGINS` names another origin. Default is closed.
- Passwords encrypted at rest; master key in `~/.mailmux/master.key` (mode 0600).
- Prefer app passwords over primary account passwords.
- Keep `message_send` behind agent confirmation.

## License

MIT — free to use, modify, and redistribute.

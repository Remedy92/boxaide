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

mailmux has one web interface: the Next.js app in `apps/web`, built as a static export. You can serve it from your own process or host it elsewhere. Either way it talks to the mailmux server on **your** machine, and it never sends your mail or your token anywhere else.

### Local (recommended — works in every browser)

```bash
npm run build
npm start
```

`npm run build` compiles the server, builds `apps/web`, and copies the export to `web-next/`. Open the URL it prints, normally `http://127.0.0.1:8787`. Same origin as the API, so nothing else is needed.

To run it on its own during development:

```bash
cd apps/web && npm install && npm run dev     # http://localhost:3000
cd apps/web && npm run build && npm run serve # the real static export
```

### Hosted (deployed somewhere else)

The page runs entirely in your browser and fetches mail directly from your machine.

Three routes exist in the export. Locally they are one screen and two spares;
on a deployment they are the whole difference between a stranger and a user:

| Route | What it is |
|---|---|
| `/` | The inbox. On a deployment `apps/web/vercel.json` redirects it to `/install` — someone who has just found the domain has no server URL or token to type into a setup form yet. |
| `/install` | The download page. The desktop installer for the visitor's operating system, and the clone-and-run command behind a link. |
| `/app` | The inbox again, at an address the redirect does not touch. This is the hosted interface; use it wherever this section says "the deployed page". |

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

**4. Point the page at your server.** Open the deployed page at **`/app`**, click **Set up mailmux**, and enter the Server URL and the token. Both are stored in your browser's localStorage and are sent only to the server URL you entered.

**5. Allow local network access (Chrome, Edge, Brave).** Since Chromium 142 the browser asks permission before a website may reach `127.0.0.1`. Allow it when prompted; if you dismissed the prompt, re-enable it under Site settings → *Apps on device*.

### Safari, and the mixed-content limit

A page served over `https` cannot reach an `http` address. For `127.0.0.1` and `localhost` Chromium and Firefox make an exception; **WebKit does not**, and there is no workaround ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934), still open). This is also why `MAILMUX_ALLOWED_ORIGINS` drops `http://` entries: the configuration that would avoid the block is the one that makes the allowlist spoofable.

If your server is not on loopback, put it behind `https` or reach it over a tunnel. Otherwise use the local build — run `mailmux serve` and open `http://127.0.0.1:8787` directly. It is the same interface.

### What the host can see

Nothing. The deployed page has no server-side code: no API routes, no server actions, no proxy, no middleware. Your token, your mail credentials and every message body travel only between your browser and your own machine.

## Desktop app

A window instead of a terminal, for people who do not want either. `apps/desktop` is an Electron shell: it starts the same server inside its own process, binds `127.0.0.1`, and uses the same `~/.mailmux` data directory, master key and bearer token. An account connected in the desktop app is the same account your agents reach over MCP.

On macOS the app also lives in the menu bar. Click the mark for a popover —
recent mail, whether an agent is listening, one button into the app; the
popover is the `/tray/` route of the same web export. Right-click for a menu:
open mailmux, install the Claude connector (opens the bundled `.mcpb` in
Claude Desktop), **Start at login** (packaged app only — it registers a macOS
login item), quit. The menu bar icon stays as long as the app runs, including
with the window closed.

```bash
npm run build                 # repository root: server + UI export
cd apps/desktop
npm install                   # its own package.json and lockfile
npm run dev                   # opens the window
```

`npm install` rebuilds `better-sqlite3` against Electron's ABI (`electron-builder install-app-deps`). If Electron's own binary is missing afterwards — this repo blocks install scripts unless `allowScripts` names them — run `node node_modules/electron/install.js` once.

Installers:

```bash
npm run dist:mac              # mac: signed dmg in apps/desktop/release/
npm run dist                  # other platforms — nsis or AppImage
```

On mac, `dist:mac` signs the app and the dmg with a Developer ID certificate pinned by hash in `scripts/sign-mac.sh` (electron-builder's by-name signing is ambiguous when the keychain holds two same-named certificates). Notarization is a separate, credential-holding step; the commands are at the top of that script. `npm run dist` builds for the platform it runs on. Both scripts re-copy the compiled server and the UI export out of the repository root first, so run the root `npm run build` again after any server change. The port follows `MAILMUX_PORT` (default 8787); if something already holds it — `mailmux serve` in a terminal, or a second copy of the app — the window does not open and the app says so.

## Agent MCP (any client)

### Claude Desktop — one click

With mailmux running, open **Connect agent** in the UI and press **Download for
Claude Desktop**, or fetch `http://127.0.0.1:8787/mailmux.mcpb` directly.
Double-click the file; Claude Desktop installs it. Nothing to configure: the
connector is a tiny stdio→HTTP proxy (`apps/mcpb`) that finds your local server
and reads the token from `~/.mailmux/bearer.token` itself. It is built into
`web-next/mailmux.mcpb` by `npm run build` (`npm run mcpb:build` on its own).

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

### stdio MCP (Claude Code / manual Claude Desktop)

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
| `chat_await_message` | Wait for the user's next message in the mailmux window |
| `chat_say` | Answer them there |
| `chat_activity` | Post a one-line "here is what I am doing" |
| `chat_history` | Re-read the conversation |

Accounts are connected once in the web UI (or API). Agents reuse the same store — **no per-agent OAuth**.

## Talking to your agent inside mailmux

The Agent view is the app's first screen, and mailmux runs no model behind it.
The agent is whichever MCP client you already use — Claude Code, Codex, Cursor,
Claude Desktop — and the four `chat_*` tools above are how it holds the
conversation in the mailmux window instead of in its own terminal. There is no
per-client integration: a long-polling tool call is the one capability every MCP
client has.

Connect the client as above, then say this to it once, in its own window:

```
You are my mailmux inbox agent. Use the mailmux MCP tools.

Loop: call chat_await_message, do the work, post the answer with chat_say, then
call chat_await_message again. Keep going until I tell you to stop.

Everything I read appears in the mailmux window, so every answer must go through
chat_say — do not answer here. A chat_await_message that returns no message is
normal; call it again. Use chat_activity for anything slow. Draft rather than
send unless I ask you to send.
```

The kickoff is not optional and cannot be automated away: MCP is client-driven,
so nothing on the mailmux side can make an agent start listening. Anything you
type before one does is queued and delivered when it arrives.

Notes on what the UI claims. "Listening" means an agent is parked in an open
`chat_await_message` — a request that is open right now, not an inference. It
never says "connected", because a stateless `POST /mcp` cannot tell a configured
client from one that was never started. Each message goes to exactly one agent,
so do not point two at the same server. The conversation is stored in
`~/.mailmux/mailmux.db`, encrypted with the same master key as the account
passwords, because an agent summarising an inbox puts mail content in those rows.

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
| `MAILMUX_HOST` | `127.0.0.1` | Bind address — see below |
| `MAILMUX_PORT` | `8787` | Port |
| `MAILMUX_TOKEN` | auto file | API/MCP bearer |
| `MAILMUX_MASTER_KEY` | auto file | AES key for passwords — see below |
| `MAILMUX_FIXTURE` | off | Demo provider |
| `MAILMUX_ALLOWED_ORIGINS` | empty | Extra browser origins allowed to call the API — see below |

### Bind address (`MAILMUX_HOST`)

The default binds to loopback, so only your own machine can reach the server. Change it and the server answers on the network, where the bearer token is the only thing between a stranger and your mail.

One behaviour changes on a non-loopback bind: `/api/local-bootstrap`, which hands out the bearer token in plaintext, answers `404` and hands out nothing. Its `Host` and `Origin` checks are browser guards, and a remote client picks both headers itself. Paste the token in by hand instead; it is in `~/.mailmux/bearer.token`.

### Master key (`MAILMUX_MASTER_KEY`)

This key encrypts your stored mail passwords. Leave it unset and mailmux generates a random one in `~/.mailmux/master.key`.

Set it to **64 hex characters** — a full random 32-byte key:

```bash
openssl rand -hex 32
```

Any other value is treated as a passphrase and stretched with scrypt (N=2¹⁷, r=8 — 128 MB per attempt, about 0.2s once at startup). The salt is random per install and stored in `~/.mailmux/master.salt`, so no precomputed table applies and the same passphrase on two machines produces two different keys. A passphrase still holds far less entropy than a random key, so prefer the hex form.

**Back up `master.salt` with your data directory.** Lose it and a passphrase no longer derives the key that encrypted your stored mail passwords.

**Upgrading:** passphrases used to be hashed once with SHA-256. The scrypt change means a passphrase set before this version derives a different key, and stored mail passwords no longer decrypt. Re-enter each account's password once, or keep the old key by setting `MAILMUX_MASTER_KEY` to the hex of `sha256(<your passphrase>)`.

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
- Loopback (`127.0.0.1`, `localhost`, `::1`) always passes, so the self-hosted UI needs no configuration.
- Requests with no `Origin` header (curl, MCP clients) are unaffected.

**What enabling this costs you.** The origin check is the last defence-in-depth layer in front of a service that holds decrypted IMAP passwords. Adding an origin means:

- Anyone who can serve a page at that exact hostname can reach your server **if they also have your bearer token**. On shared hosting platforms that includes preview deployments and anyone with deploy access. Prefer a custom domain you control over a platform-assigned hostname.
- It is the only remaining barrier against a DNS-rebinding page reaching your loopback service, so the list should stay as short as you can make it.
- The token is still required on every request. `Access-Control-Allow-Credentials` is never sent — mailmux authenticates by header, never by cookie — so no page can ride ambient credentials.
- `/api/local-bootstrap`, which hands out the bearer token in plaintext, is **not** widened by this variable. It stays loopback-only. A remote page must have its token pasted in by a human.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

One Node process:

- `/` — web UI (the `apps/web` export, served from `web-next/`)  
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
- Passwords encrypted at rest; master key in `~/.mailmux/master.key` (mode 0600). A passphrase in `MAILMUX_MASTER_KEY` is stretched with scrypt against `~/.mailmux/master.salt`.
- Prefer app passwords over primary account passwords.
- Keep `message_send` behind agent confirmation.

## License

MIT — free to use, modify, and redistribute.

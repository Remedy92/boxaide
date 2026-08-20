# Boxaide

**Free, self-hosted multi-mailbox agentic inbox.**  
Connect any IMAP/SMTP mail. One unified inbox in the browser. One MCP surface for every agent.

On top of the inbox: a CRM derived from your own mail, scheduled agent automations, and outreach that no agent can send on its own. See [Agent work platform](#agent-work-platform--crm-automations-outreach).

No paid SaaS required for core receive + send. MIT licensed.

Formerly Sley, then Mailmux. The repo is [Remedy92/boxaide](https://github.com/Remedy92/boxaide).

## Quick start

```bash
cd Projects/boxaide   # or your clone path
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

### Archiving

`e` in the list, or the archive button in the reader, moves the message to the
account's **Archive** mailbox — the one your server advertises as `\Archive`,
or Gmail's *All Mail*, which is what archiving means there. Nothing is deleted,
and the toast's **Undo** moves the message straight back to the folder it came
from.

A mailbox whose server has no Archive folder says so instead of guessing:
create one named `Archive` in your mail provider and it is picked up on the
next archive.

### Production-ish start

```bash
npm run build
npm start
# or: node dist/cli.js serve
```

## Using the hosted interface

Boxaide has one web interface: the Next.js app in `apps/web`, built as a static export. You can serve it from your own process or host it elsewhere. Either way it talks to the Boxaide server on **your** machine, and it never sends your mail or your token anywhere else.

The public site is **https://boxaide.tech**.

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

Four routes exist in the export. Locally `/` is the inbox. On a deployment
the difference is who has a server:

| Route | What it is |
|---|---|
| `/` | The inbox. On a deployment `apps/web/vercel.json` redirects it to `/install`. |
| `/install` | The download page. A Mac dmg when one exists; Windows and Linux have no installer yet, so those buttons open the release page. Clone-and-run is a line at the bottom. |
| `/app` | The inbox again, at an address the redirect does not touch. Use this wherever this section says "the deployed page". |
| `/tray/` | The menu-bar popover the Mac app loads. Not a visitor page. |

**1. Deploy `apps/web`.** On Vercel and equivalents, set the project's **Root Directory** to `apps/web` and leave the build and output commands on auto. That setting is what keeps the CLI's `better-sqlite3` out of the front-end install; it lives in the dashboard and cannot be expressed in a file. Do **not** add a `workspaces` key to the root `package.json`.

No environment variable is required. One optional, non-secret variable exists:

| Name | Value | Purpose |
|---|---|---|
| `NEXT_PUBLIC_DEFAULT_API_BASE` | `http://127.0.0.1:8787` | The pre-filled Server URL on a browser with nothing in localStorage. Public by definition — it is inlined into the bundle at build time. Omit it and the same default comes from `apps/web/src/lib/constants.ts`. |

**2. Allow the origin.** On **your** machine, not on the host:

```bash
BOXAIDE_ALLOWED_ORIGINS=https://boxaide.tech boxaide serve
```

See the rules and the cost of doing this under [Browser origins](#browser-origins-boxaide_allowed_origins) below.

**3. Copy the token.** `boxaide serve` prints it on first run; it is also in `bearer.token` inside your data directory (`~/.boxaide` by default, else `~/.sley`, else `~/.mailmux`, if one of those folders already exists).

**4. Point the page at your server.** Open the deployed page at **`/app`**, click **Set up Boxaide**, and enter the Server URL and the token. Both are stored in your browser's localStorage (`boxaide.*`) and are sent only to the server URL you entered. A first run still reads leftover `sley.*`, `mailmux.*` and `mailmux_token` keys once.

**5. Allow local network access (Chrome, Edge, Brave).** Since Chromium 142 the browser asks permission before a website may reach `127.0.0.1`. Allow it when prompted; if you dismissed the prompt, re-enable it under Site settings → *Apps on device*.

### Safari, and the mixed-content limit

A page served over `https` cannot reach an `http` address. For `127.0.0.1` and `localhost` Chromium and Firefox make an exception; **WebKit does not**, and there is no workaround ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934), still open). This is also why `BOXAIDE_ALLOWED_ORIGINS` drops `http://` entries: the configuration that would avoid the block is the one that makes the allowlist spoofable.

If your server is not on loopback, put it behind `https` or reach it over a tunnel. Otherwise use the local build — run `boxaide serve` and open `http://127.0.0.1:8787` directly. It is the same interface.

### What the host can see

Nothing. The deployed page has no server-side code: no API routes, no server actions, no proxy, no middleware. Your token, your mail credentials and every message body travel only between your browser and your own machine.

## Desktop app

A window instead of a terminal, for people who do not want either. `apps/desktop` is an Electron shell: it starts the same server inside its own process, binds `127.0.0.1`, and uses the same `~/.boxaide` data directory, master key and bearer token. An account connected in the desktop app is the same account your agents reach over MCP.

On macOS the app also lives in the menu bar. Click the mark for a popover —
recent mail, whether an agent is listening, one button into the app; the
popover is the `/tray/` route of the same web export. Right-click for a menu:
open Boxaide, install the Claude connector (opens the bundled `.mcpb` in
Claude Desktop), **Start at login** (packaged app only — it registers a macOS
login item), quit. The menu bar icon stays as long as the app runs, including
with the window closed.

```bash
npm run desktop
```

That compiles the server, installs Electron deps only when the lockfile changed, downloads the Electron binary once, copies `dist/` and `web-next/` into the app if they changed, and opens the window. A second run skips the install and the download. The web UI rebuilds only when `apps/web/src` no longer matches the last `web:sync` stamp.

```bash
npm run desktop:dist          # same prepare, then signed mac dmg in apps/desktop/release/
```

On mac, signing uses a Developer ID certificate pinned by hash in `apps/desktop/scripts/sign-mac.sh` (electron-builder's by-name signing is ambiguous when the keychain holds two same-named certificates). Notarization is a separate, credential-holding step; the commands are at the top of that script. The port follows `BOXAIDE_PORT` (default 8787); if something already holds it — `boxaide serve` in a terminal, or a second copy of the app — the window does not open and the app says so.

The install button serves GitHub `releases/latest`. CI does not publish a release. After a merge to master, from the **main checkout** (not a worktree):

```bash
./scripts/ship_status.sh   # is origin/master what a visitor downloads?
./scripts/ship.sh          # bump, pack, sign, publish latest
./scripts/install-hooks.sh # once: remind on pull/checkout of master
```

`ship.sh` is the only publisher. A git hook only prints the status; it never packs. Pass `--dry-run` to see the plan.

`ship.sh` defaults `APPLE_KEYCHAIN_PROFILE` to `mailmux-notary` and refuses to publish unless that profile works and the dmg carries a notarization ticket. A release is three files: `boxaide-mac.dmg`, `boxaide-mac.zip`, and `latest-mac.yml`. Mint the profile once. The keychain profile name is historical:

```bash
xcrun notarytool store-credentials mailmux-notary --apple-id <apple-id> --team-id 22DPQ7YCAS
```

## Agent MCP (any client)

### Claude Desktop — one click

With Boxaide running, open **Connect agent** in the UI and press **Download for
Claude Desktop**, or fetch `http://127.0.0.1:8787/boxaide.mcpb` directly.
Double-click the file; Claude Desktop installs it. Nothing to configure: the
connector is a tiny stdio→HTTP proxy (`apps/mcpb`) that finds your local server
and reads the token from `~/.boxaide/bearer.token` itself. It is built into
`web-next/boxaide.mcpb` by `npm run build` (`npm run mcpb:build` on its own).

### HTTP MCP (Cursor / remote-capable clients)

```json
{
  "mcpServers": {
    "boxaide": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

Token lives in `~/.boxaide/bearer.token` (or `BOXAIDE_TOKEN`).

### stdio MCP (Claude Code / manual Claude Desktop)

```bash
npm run mcp
# or: npx tsx src/cli.ts mcp
```

```json
{
  "mcpServers": {
    "boxaide": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/boxaide/src/cli.ts", "mcp"],
      "env": {
        "BOXAIDE_DATA_DIR": "/Users/you/.boxaide"
      }
    }
  }
}
```

Agents that speak TOML use `[mcp_servers.boxaide]`. Tool calls show up as `mcp__boxaide__*`.

### Tools

| Tool | Purpose |
|------|---------|
| `accounts_list` | Connected aliases |
| `messages_list` | Inbox list (`account`: alias or `all`) |
| `messages_search` | Free-text search |
| `message_get` | Full body |
| `message_mark_read` | Set or clear the read flag |
| `message_archive` | Move one message to the account's Archive mailbox |
| `message_move` | Move one message to any folder (also the undo of an archive) |
| `folders_list` | Folders on one account |
| `draft_create` / `draft_update` / `drafts_list` / `draft_delete` | Drafts in the mailbox |
| `message_send` | Send now (confirm in your agent). Not outreach approval. |
| `chat_await_message` | Wait for the user's next message in the Boxaide window |
| `chat_say` | Answer them there |
| `chat_activity` | Post a one-line "here is what I am doing" |
| `chat_history` | Re-read the conversation |

The platform modules add their own tools. Full list in [Agent work platform](#agent-work-platform--crm-automations-outreach).

| Group | Tools |
|------|---------|
| CRM | `crm_sync`, `crm_contacts_search`, `crm_contact_get`, `crm_contact_upsert`, `crm_contact_delete`, `crm_note_add`, `crm_org_upsert`, `crm_orgs_list`, `crm_interactions_list`, `crm_pipeline_get`, `crm_deal_upsert`, `crm_deal_move`, `crm_deal_delete` |
| Automations | `automation_create`, `automation_update`, `automation_delete`, `automations_list`, `automation_run_now`, `automation_runs_list` |
| Outreach | `campaign_create`, `campaign_update`, `campaigns_list`, `campaign_add_contacts`, `outbox_queue_draft`, `outbox_list`, `suppression_add`, `suppression_list` |

There is **no tool that approves, rejects or sends an outbox row**. That is a human action in the web UI.

Accounts are connected once in the web UI (or API). Agents reuse the same store — **no per-agent OAuth**.

## Talking to your agent inside Boxaide

The Agent view is the app's first screen. Boxaide does not host a model. The
agent is a local CLI you already have — Claude Code, Grok, Codex, Cursor,
Claude Desktop — talking MCP. The four `chat_*` tools hold the conversation in
the Boxaide window instead of in that client's terminal.

**Start** / **Stop** on the rail spawn or kill the installed CLI and feed it
the kickoff prompt (`src/agent/launcher.ts`). You can still paste the same
loop into a client you launched yourself:

```
You are my Boxaide inbox agent. Use the Boxaide MCP tools.

Loop: call chat_await_message, do the work, post the answer with chat_say, then
call chat_await_message again. Keep going until I tell you to stop.

Everything I read appears in the Boxaide window, so every answer must go through
chat_say — do not answer here. A chat_await_message that returns no message is
normal; call it again. Use chat_activity for anything slow. Draft rather than
send unless I ask you to send.
```

Anything you type before an agent is listening is queued and delivered when
one arrives.

Notes on what the UI claims. "Listening" means an agent is parked in an open
`chat_await_message` — a request that is open right now, not an inference. It
never says "connected", because a stateless `POST /mcp` cannot tell a configured
client from one that was never started. Each message goes to exactly one agent,
so do not point two at the same server. The conversation is stored in
`~/.boxaide/boxaide.db`, encrypted with the same master key as the account
passwords, because an agent summarising an inbox puts mail content in those rows.

## Agent work platform — CRM, automations, outreach

Three modules ship with the inbox. They are free, MIT, and run only on your machine. There is no sync, no tracking pixel, no click redirect, and no account anywhere else.

| Module | What it is | Where you see it |
|---|---|---|
| **CRM** | Contacts, organisations, notes, an interaction timeline and a deal pipeline, all derived from mail you already have. | **People** and **Pipeline** views |
| **Automations** | Named prompts on a cron. Each run is a one-shot headless agent with the Boxaide tools and no user to talk to. | **Automations** view |
| **Outreach** | Campaigns of timed steps that produce drafts. Every draft waits for you. | **Outreach** view |

### CRM: derived, not entered

You do not type your contacts in. `crm_sync` walks INBOX and the Sent folder of each account and records who you actually mail with: contact per address, one interaction row per message, organisation per non-free email domain. It runs every 10 minutes while `boxaide serve` is up, and on demand from the tool or `POST /api/crm/sync`.

Free-provider domains (gmail.com, outlook.com, proton.me, …) never create an organisation. Automated senders (`no-reply@`, `postmaster@`, bounce addresses) are skipped. You can still add or correct anything by hand, or ask the agent to.

### Automations are created by talking to the agent

The Automations view has no create form. This is deliberate: an automation *is* a prompt, and writing a good one is a conversation, not a text field.

Say what you want to whichever MCP client you already use:

> Every weekday at 8, look at yesterday's unread mail, update the CRM, and queue a follow-up draft for anyone in the "warm" tag I have not mailed in two weeks.

The agent calls `automation_create` with a name, a 5-field cron and the prompt it just wrote for a future run of itself. The view then owns the automation: enable and disable it, see next and last run, run it now, read the log of any past run.

What a run may do:

| | |
|---|---|
| Can | read mail, search, read and write CRM, save drafts, queue outreach into the outbox |
| Cannot | talk to you (no chat tools — there is no one at the window), call `message_send`, approve anything |
| Limits | one run at a time, queued if another is going; 15-minute hard timeout, then killed |

Run logs are stored encrypted, like everything else mail-derived.

#### Importing Claude Desktop scheduled tasks

Claude Desktop keeps each scheduled task as a folder under `~/.claude/scheduled-tasks/<name>/SKILL.md`, with a name and description in front matter and the instructions in the body. Those are exactly the two things `automation_create` needs, minus a schedule.

Ask the agent to do the move:

> Read ~/.claude/scheduled-tasks/*/SKILL.md and recreate each one as a Boxaide automation.

It reads the folder itself with its own file tools and calls `automation_create` per task: `name` from the front matter, `prompt` from the body. A `SKILL.md` does not carry a cron, so the agent asks you for the schedule of each one, or proposes one from the description. Nothing is imported silently, and nothing is deleted on the Claude Desktop side.

Why this is a conversation and not an importer: the two systems do not have the same permissions. A Claude Desktop task can talk to you and reach everything on your machine. A Boxaide automation cannot talk to anyone and works through the Boxaide tools. A task that assumed it could ask a question needs rewriting before it makes sense on a cron here, and the agent that reads it is the thing best placed to rewrite it.

### No auto-send

**No agent sends outreach.** Campaigns and `outbox_queue_draft` land as
`pending` rows. The Outreach view shows each one — recipient, subject, body —
with **Approve**, **Edit** or **Reject**. Approval is REST only, from the
browser, by you. There is no MCP tool that approves, rejects or sends an
outbox row.

That is the outreach path only. An external MCP client can still call
`message_send` and the mail leaves immediately. Agents Boxaide **launches**
(rail Start, and every automation run) do not get `message_send`.

**Edit** does not rewrite the queued row. It opens the composer with that
text; the queued copy is rejected after you send.

| Step | Who |
|---|---|
| Write the draft | agent |
| Queue it into the outbox | agent |
| Read it, approve or reject it | you, in the browser |
| Put it on the wire | server, after approval |

The rail badges the pending count, and the desktop app raises a notification and a dock badge when it rises. You are told about waiting drafts; you are never told after the fact about sent ones.

Sending is throttled server-side even after approval: at least 60 seconds between engine sends with jitter, and at most `BOXAIDE_SEND_DAILY_CAP` (default 50) per account per UTC day. Over the cap, an approved row simply goes out the next day.

### Suppression is a server rule, not a checkbox

`suppression` is a table of addresses that must not be mailed. The check lives inside `MailService.sendMessage`, so it applies to every path — outreach, a manual compose, an agent's `message_send`. A suppressed recipient fails the send with `recipient suppressed: <email>`.

| Reason | How an address gets there |
|---|---|
| `reply-stop` | Someone replied "stop", "unsubscribe" or "opt out" to a campaign. Detected on the inbound message; the campaign contact stops immediately. |
| `manual` | You added it in the Outreach view. |
| `bounce` | You or an agent recorded a hard bounce with `suppression_add`. A failed send does not add this on its own. |
| `agent` | An agent added it with `suppression_add`. |

Only a human can override, and only through REST: `POST /api/messages/send` accepts `overrideSuppression: true`. The MCP `message_send` tool does not expose the flag, so no agent can override a suppression at all.

Every outreach step, including the first, ends with a plain-text opt-out line telling the recipient to reply with "stop". There are no open pixels and no click-tracking links — they conflict with the privacy posture and are out of scope on purpose.

### Everything stays on your machine

Same store, same master key, same file as the rest of Boxaide: `~/.boxaide/boxaide.db`.

| Data | At rest |
|---|---|
| Note text, interaction subjects and snippets, campaign step subjects and bodies, outbox subjects and bodies, automation run logs | encrypted, AES-256-GCM, same master key as your mail passwords |
| Contact email and name, organisation name and domain, tags, deal titles, suppression addresses | plaintext — they are CRM identity, needed for UNIQUE and for search |
| Automation prompts | plaintext — you wrote them, they are not mail content |

Mail, CRM, automations and outreach stay in that directory. There is no
analytics SDK and no mail sync to a host. The process does poll GitHub for
updates (`GET /api/update`, and `electron-updater` in the Mac app). The
marketing UI at `https://boxaide.tech` is a static export and never sees your
data. Back up `~/.boxaide` and you have backed up the store.

## Install options

| Method | Command |
|--------|---------|
| Dev | `npm install && npm run dev` |
| Fixture demo | `npm run dev -- --fixture` |
| Built | `npm run build && npm start` |
| Init data dir | `npx tsx src/cli.ts init` |

### Env

Each `BOXAIDE_*` name is preferred. Then `SLEY_*`, then `MAILMUX_*`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `BOXAIDE_DATA_DIR` | `~/.boxaide` | SQLite + keys. Else the first existing of `~/.sley`, `~/.mailmux`. |
| `BOXAIDE_HOST` | `127.0.0.1` | Bind address — see below |
| `BOXAIDE_PORT` | `8787` | Port |
| `BOXAIDE_TOKEN` | auto file | API/MCP bearer |
| `BOXAIDE_MASTER_KEY` | auto file | AES key for passwords — see below |
| `BOXAIDE_FIXTURE` | off | Demo provider |
| `BOXAIDE_ALLOWED_ORIGINS` | empty | Extra browser origins allowed to call the API — see below |
| `BOXAIDE_SEND_DAILY_CAP` | `50` | Approved outreach sends per account per UTC day |

### Bind address (`BOXAIDE_HOST`)

The default binds to loopback, so only your own machine can reach the server. Change it and the server answers on the network, where the bearer token is the only thing between a stranger and your mail.

One behaviour changes on a non-loopback bind: `/api/local-bootstrap`, which hands out the bearer token in plaintext, answers `404` and hands out nothing. Its `Host` and `Origin` checks are browser guards, and a remote client picks both headers itself. Paste the token in by hand instead; it is in `~/.boxaide/bearer.token`.

### Master key (`BOXAIDE_MASTER_KEY`)

This key encrypts your stored mail passwords. Leave it unset and Boxaide generates a random one in `~/.boxaide/master.key`.

Set it to **64 hex characters** — a full random 32-byte key:

```bash
openssl rand -hex 32
```

Any other value is treated as a passphrase and stretched with scrypt (N=2¹⁷, r=8 — 128 MB per attempt, about 0.2s once at startup). The salt is random per install and stored in `~/.boxaide/master.salt`, so no precomputed table applies and the same passphrase on two machines produces two different keys. A passphrase still holds far less entropy than a random key, so prefer the hex form.

**Back up `master.salt` with your data directory.** Lose it and a passphrase no longer derives the key that encrypted your stored mail passwords.

**Upgrading:** passphrases used to be hashed once with SHA-256. The scrypt change means a passphrase set before this version derives a different key, and stored mail passwords no longer decrypt. Re-enter each account's password once, or keep the old key by setting `BOXAIDE_MASTER_KEY` to the hex of `sha256(<your passphrase>)`.

### Browser origins (`BOXAIDE_ALLOWED_ORIGINS`)

By default Boxaide accepts browser requests **only from your own machine**. A page on any other origin gets `403 {"error":"forbidden origin"}`. Leave the variable unset and nothing changes.

Set it when you want a web interface hosted somewhere else — a deployment of `apps/web`, for example — to talk to your local server. The page still runs entirely in your browser and still fetches mail directly from your machine; the variable only tells your server which page origins it will answer. See [Using the hosted interface](#using-the-hosted-interface) for the full walkthrough.

```bash
BOXAIDE_ALLOWED_ORIGINS=https://boxaide.tech boxaide serve
```

Rules:

- Comma-separated, exact origins. `https://a.example.com,https://b.example.com`.
- Only `https://` entries are kept. A plaintext origin is trivially spoofed on a hostile network, so `http://` entries are dropped.
- Path, query and case are stripped: `https://A.App/x` becomes `https://a.app`. A port must match exactly — `https://a.app` does not allow `https://a.app:8443`.
- **`*` is ignored on purpose.** Boxaide holds your mail credentials; an any-origin allowlist would let any page you visit probe your server.
- Loopback (`127.0.0.1`, `localhost`, `::1`) always passes, so the self-hosted UI needs no configuration.
- Requests with no `Origin` header (curl, MCP clients) are unaffected.

**What enabling this costs you.** The origin check is the last defence-in-depth layer in front of a service that holds decrypted IMAP passwords. Adding an origin means:

- Anyone who can serve a page at that exact hostname can reach your server **if they also have your bearer token**. On shared hosting platforms that includes preview deployments and anyone with deploy access. Prefer a custom domain you control over a platform-assigned hostname.
- It is the only remaining barrier against a DNS-rebinding page reaching your loopback service, so the list should stay as short as you can make it.
- The token is still required on every request. `Access-Control-Allow-Credentials` is never sent — Boxaide authenticates by header, never by cookie — so no page can ride ambient credentials.
- `/api/local-bootstrap`, which hands out the bearer token in plaintext, is **not** widened by this variable. It stays loopback-only. A remote page must have its token pasted in by a human.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

One Node process:

- `/` — web UI (the `apps/web` export, served from `web-next/`)  
- `/api/*` — REST (same mail core)  
- `/mcp` — JSON-RPC MCP  
- `boxaide mcp` — stdio MCP  

IMAP via **ImapFlow**, SMTP via **Nodemailer**, secrets **AES-256-GCM**, state **SQLite**.

## Tests

```bash
npm test
```

Tests call **shipped** `MailService`, crypto, HTTP app, and MCP handlers with an in-memory **FixtureProvider** — no live mail accounts required.

## Security notes

- Default bind is localhost.
- Browser requests are loopback-only unless `BOXAIDE_ALLOWED_ORIGINS` names another origin. Default is closed.
- Passwords encrypted at rest; master key in `~/.boxaide/master.key` (mode 0600). A passphrase in `BOXAIDE_MASTER_KEY` is stretched with scrypt against `~/.boxaide/master.salt`.
- Prefer app passwords over primary account passwords.
- Keep `message_send` behind agent confirmation.
- Outreach cannot be sent by an agent. Approval is REST-only and human; no MCP tool approves, rejects or sends an outbox row.
- Suppression is enforced inside `MailService.sendMessage`, so it covers every send path. Only REST can override it.
- Mail-derived text in CRM, outreach and automation rows is encrypted with the same master key as your passwords.

## License

MIT — free to use, modify, and redistribute.

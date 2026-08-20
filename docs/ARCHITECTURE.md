# Architecture decision — Boxaide

**Date:** 2026-08-09  
**Status:** accepted

## Decision

Ship **Boxaide** as a single **Node 22+ / TypeScript** process:

| Layer | Choice |
|-------|--------|
| HTTP | Hono |
| MCP | `@modelcontextprotocol/sdk` (Streamable HTTP + stdio CLI) |
| Receive | IMAP via **ImapFlow** |
| Send | SMTP via **Nodemailer** |
| State | SQLite (`better-sqlite3`) |
| Secrets | AES-256-GCM, master key file / `BOXAIDE_MASTER_KEY` (64-hex verbatim, anything else stretched with scrypt; `MAILMUX_MASTER_KEY` if unset) |
| Web | One front end: a Next.js App Router build in `apps/web`, static and fully client-side (see below) |
| Tests | Vitest + in-process **FixtureProvider** (no live mail required) |

## Why not alternatives

- **Python FastAPI:** MCP fine; multi-account IMAP async messier; dual install friction.
- **Go binary:** best install size; slower path to usable unified inbox UI + MCP polish.
- **Gmail-API-first:** fails “any mail” free; OAuth verification friction for self-host.
- **JSON files only:** race-prone under concurrent web + MCP.

## Principles

1. **IMAP/SMTP baseline** — any provider with app password or IMAP access.
2. **One process** — `/` UI, `/api/*` REST, `/mcp` MCP share the same `MailService`.
3. **Provider interface** — real IMAP and fixture implement the same contract so tests call shipped code.
4. **Local by default** — bind `127.0.0.1`; bearer token gates API + MCP.
5. **A launched agent holds a narrower credential than the app** — see Agent
   scopes below.
5. **MIT, zero paid SaaS** for core receive/send.

## The Next.js front end (`apps/web`)

**Date:** 2026-08-09 · **Status:** accepted

`apps/web` is a Next.js App Router build. It talks to the Boxaide server from the browser, over HTTP, with a bearer token. The backend holds no UI state.

| Decision | Reason |
|---|---|
| **`output: "export"` — a static export, no server** | The same artefact is deployable to a static host *and* servable by the Node process. It also makes the privacy claim structural rather than a policy: with no route handlers, no server actions and no proxy, a host physically cannot see the token, the mail credentials or a message body. |
| **Every data component is a Client Component** | All fetching happens in the browser, directly against the user's own machine. `src/app/layout.tsx` is the only file without `"use client"`, and it fetches nothing. |
| **Base URL and token in `localStorage` only** | No cookies, no env var carries a secret. `NEXT_PUBLIC_DEFAULT_API_BASE` sets only the pre-filled default (`http://127.0.0.1:8787`) and is public by definition. |
| **One route, selection in the URL hash** | `output: "export"` bans dynamic routes without `generateStaticParams`, and message ids are unknowable at build time. Selection is mirrored to `#/a/<accountId>/m/<messageId>` with `history.replaceState`. |
| **Its own `package.json` and lockfile; no root `workspaces` key** | A workspace would hoist `better-sqlite3` into the front-end install and force a native build on every deploy. |
| **`bodyHtml` renders only sanitised, only framed** | It is raw unsanitised sender HTML. `HtmlBody` passes it through DOMPurify and renders the result in an `<iframe srcdoc>` whose `sandbox` omits both `allow-scripts` and `allow-same-origin`, and whose own `<meta>` CSP is `default-src 'none'` — four independent layers: sanitised, script-forbidden, opaque-origin, fetch-fenced. The opaque origin is why the frame scrolls internally instead of auto-sizing: measuring height needs a same-origin frame, and that trade is refused. Remote images are blocked per message until the user clicks "Load images"; `cid:` images arrive as `data:` URIs from mailparser and always show. It never enters the React tree: `react/no-danger` is an ESLint **error**, and the only `dangerouslySetInnerHTML` is a fixed desktop UA marker in `layout.tsx`. "View HTML source" still shows the raw source escaped inside a `<pre>`. |
| **`/api/agent-connect` is never called; `/api/local-bootstrap` requires a desktop capability** | agent-connect embeds the token, and the MCP snippet is built client-side from `localStorage` instead. The Electron shell places an unguessable one-time capability in the URL fragment, which HTTP never receives; the wizard strips and exchanges it. A normal browser, local or remote, requires a human to paste the token. |

Serving it from the Node process:

```bash
npm run web:build   # npm ci + next build inside apps/web
npm run web:sync    # copy apps/web/out -> web-next/
npm start
```

`resolveWebRoot()` (`src/app.ts`) serves `web-next/`. There is no second UI to fall back to: with no export present, `/` returns a 500 telling you to run `npm run build`. Served that way the page is same-origin with the API, so no allowlist entry, no preflight and no Local Network Access prompt applies — which is why it is the recommended path for Safari users (WebKit blocks an `https` page from reaching `127.0.0.1`, [bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934)).

Deploying it to a static host (Vercel and equivalents): set the project's **Root Directory** to `apps/web`. Nothing in the repo can express that — it is a dashboard setting, and without it the platform builds the CLI package at the root instead. Then set `BOXAIDE_ALLOWED_ORIGINS` on **your** machine to the deployed origin.

## Cross-origin access (`BOXAIDE_ALLOWED_ORIGINS`)

**Date:** 2026-08-09 · **Status:** accepted

A browser page served from anywhere other than the Boxaide process itself cannot reach `/api/*` by default. The `Origin` header must be absent (curl, MCP clients) or loopback; anything else is `403 forbidden origin`, and no `Access-Control-*` header is emitted at all.

`BOXAIDE_ALLOWED_ORIGINS` adds exact origins to that gate so a separately hosted browser UI can call the local server directly. The decisions behind it:

| Decision | Reason |
|---|---|
| **Default empty (closed)** | Unset means byte-identical behaviour to before the change. Opening a service that holds decrypted IMAP passwords must be a deliberate act. |
| **Loopback stays implicitly allowed** | The same-origin static build needs no configuration. |
| **`*` parsed and dropped, never honoured** | The origin check is the surviving defence against DNS rebinding against a loopback service. `*` deletes it, and turns a leaked token into something usable from any page the user visits. |
| **`https:` only for non-loopback entries** | A plaintext allowlisted origin is trivially spoofed on a hostile network. |
| **Echo the *parsed* origin, never `*` and never the raw header** | A per-origin allowlist is meaningless without an exact echo, and it is a prerequisite for the `Vary` contract. The value comes from `new URL(origin).origin`, because the WHATWG parser reads a backslash as a slash: `https://good.example\.evil.com` passes the allowlist as `https://good.example`, and echoing the raw string back would hand the response to the attacker's origin. |
| **`Vary: Origin` on every response, including 401 and 403** | Without it a proxy, service worker or tunnel can serve one origin's answer to another. |
| **`Access-Control-Allow-Credentials` never sent** | Boxaide authenticates by header, never by cookie. Ambient credentials must stay impossible. |
| **`Access-Control-Allow-Headers: authorization, content-type`** | Exactly what the client sends. Echoing the request's header list back would make the allowlist meaningless. |
| **Preflight answered before the auth gate** | An `OPTIONS` preflight carries no `Authorization` by spec, so gating it on the token makes CORS impossible. The origin allowlist is the control that applies; a preflight runs no handler and returns an empty 204. |
| **`/api/local-bootstrap` deliberately not widened** | It returns the bearer token only when three controls hold: the server bind is loopback, Host/Origin are loopback, and the request presents the desktop shell's random one-time capability. The capability travels in a URL fragment, is stripped immediately, and is consumed on first use. Responses remain `Cache-Control: no-store` + `Vary: Origin`. A normal browser must have its token pasted in by a human. |

Residual risk: allowlisting a hostname means anyone who can serve a page there — a preview deployment on a shared team, a hijacked account — can reach the server **if they also hold the token**. Prefer a custom domain over a platform-assigned hostname, and keep the list short.

Implementation: `parseAllowedOrigins` / `isApiOriginAllowed` / `applyCors` / `corsPreflight` in `src/api/routes.ts`, threaded through `AppConfig.allowedOrigins` (`src/config.ts`) into `createApi`, `/mcp` and `/health` (`src/app.ts`). Covered by `test/security-http.test.ts`.

## Agent scopes

Boxaide launches agent CLIs. Each launch gets a credential minted for it, bound
to a scope, accepted on `/mcp` and nowhere else, and revoked when that launch
ends. The master bearer is never handed to a spawned process.

| Decision | Why |
| --- | --- |
| **The scope is enforced by this server, not by the CLI** | It used to be enforced by whichever per-tool allowlist flag the CLI happened to offer, so a CLI without one could not be launched at all. Moving it here made three more CLIs launchable and made the boundary the same for all of them. |
| **Both the tool listing and the tool call are filtered** | Hiding a tool is a hint; a model that has seen the name once will call it. `dispatch` is the single choke point every transport reaches. |
| **A tool no scope names is denied** | The failure to design against is a tool added to the server and forgotten in `scope.ts`. Silence means no. |
| **`message_send`, `meeting_create`, `meeting_cancel` are inside every scope, and none of them acts** | They used to be outside every scope, which also meant an inbox agent could not answer an inbox. A scoped caller reaching one now records the exact call and it is put in front of the user; Boxaide performs it when they approve it. The risk is answered by the person who reads the card, not by a name missing from a list. See the approval queue below. |
| **Scoped tokens are rejected on `/api/*`** | A launched agent has no business reading settings, minting credentials, or starting another agent. Before scopes it held the master bearer and could do all three. |
| **Nothing an agent is pointed at lives inside the data directory** | The data directory holds `bearer.token` and `master.key`. An agent standing in `<dataDir>/agent-workdir` could `cat ../bearer.token` and hold the credential the scope exists to withhold. Workdirs, run directories and config homes all sit under `<dataDir>-agents` instead — which is also what makes the sandbox rule below expressible: one subtree the agent owns, one it must never see, no overlap. |
| **In memory only** | A credential that outlived the process would be one nobody can see and nobody revokes. A restart has already killed every agent. |
| **A CLI whose config Boxaide cannot control refuses to launch** | `AgentSpec.preflight`. Antigravity reads MCP servers from a file in the user's home that overrides the one a launch writes, so a stale entry there would decide the credential. It says so and stops instead. |

Implementation: `src/mcp/scope.ts` (policy), `src/mcp/scoped-tokens.ts` (mint,
resolve, revoke), `mcpAuth` in `src/app.ts` (which credential), `dispatch` in
`src/mcp/server.ts` (enforcement), `AgentLauncher.launchCtx` (per-launch
credential). Covered by `test/mcp-scope.test.ts`.

## Agent sandbox

The scope decides what an agent may do with Boxaide's tools. It cannot decide
what the agent does with the machine — and an agent that reads `bearer.token`
off the disk stops being a scoped caller. So every spawn is wrapped in the
operating system's own boundary. Same shape as the scope: one mechanism, one
place, applied to every CLI rather than to the ones that offer a flag.

| Decision | Why |
| --- | --- |
| **`workspace` is simply on; it is not a question the user is asked** | It shipped as a per-launch switch in the rail. That was wrong twice: whoever presses Start cannot reason about which files a CLI reads, and the switch's other position was the one where the agent could read `bearer.token`. `full` remains as an install-level escape (`BOXAIDE_AGENT_ACCESS=full`) and as what a machine with no sandbox gets. Scheduled runs are confined too — those are unattended and the mail they read was written by strangers. |
| **The whole first path segment under `$HOME` is allowed for a binary** | Every agent CLI installs into the home and no two agree where: `~/.local/share/claude`, `~/.grok/bin`, `~/.bun/install/global`, `~/.codex/packages`, `~/.nvm/versions`. A rule tuned to those five breaks on the sixth. Coarse on purpose — `~/.ssh`, `~/Documents` and the data directory are not one directory deep under a dotted install root. |
| **A spec declares what its CLI needs beyond that, and declares it writable** | `AgentSpec.sandbox`. OpenCode creates four directories under the home before it will run at all; grok, codex and agy keep a sign-in they rewrite on every token refresh. There used to be a read-only category for "credentials the CLI only consults" — no such CLI exists, and it is what made a confined agy start, fail to save its session, wait, and exit with nothing the user ever saw. |
| **The driver's per-turn children are wrapped too** | Claude Code has no long-lived child — its turns *are* the agent. `DriveOptions.command` carries the wrap so a driver cannot be the one spawn site that forgets. |
| **An unavailable sandbox runs the agent unconfined and says so** | macOS only today. `confineCommand` still refuses what it cannot deliver; the decision is made one level up in `resolveAccess`, because with the rail switch gone a refusal would mean nobody outside macOS can start an agent at all. The launch reports `accessNotice`, which the rail shows verbatim. What it must never do is stay quiet — a downgrade nobody notices is the failure this exists to prevent. |
| **The network is open at both levels** | The agent has a model provider and Boxaide to talk to. Confining reads keeps the master credential out of its hands; this is not an exfiltration boundary and does not claim to be. |

Implementation: `src/agent/sandbox.ts` (profile and command), `AgentLauncher.confine`
(every spawn), `AgentSpec.sandbox` (per-CLI needs), `config.agentAccess` (the
install default). Covered by `test/agent-sandbox.test.ts`, which asserts the
pure parts everywhere and runs real confined processes on macOS.

## Approval queue

Sending mail, creating a meeting and cancelling one are the three things an
agent does that another person sees at once, and it decides to do them after
reading text strangers wrote. The first answer was to take the tools away,
which also removed the reason to point an agent at an inbox. The answer now is
a person: the agent asks, Boxaide acts.

| Decision | Why |
| --- | --- |
| **The request is queued, not blocked** | A blocking prompt cannot be answered at 03:00, so a scheduled run could never ask. A stored row can: the run ends, and the request is in the window in the morning. It also means nothing depends on the asking agent still being alive. |
| **The row holds the arguments, and approval replays them through the same dispatch** | There is no second implementation of sending that could drift from the first. It is also why the card's text is derived from the arguments every time it is drawn rather than stored beside them — what the user reads is what will happen. |
| **`args_enc` is encrypted with the master key** | The row holds mail bodies and attendee addresses. Mail content has never been at rest in plaintext anywhere else in this product. |
| **The claim is a guarded `UPDATE ... WHERE state = 'pending'`** | Two windows showing the same card is the normal case. A second Approve after the first has already sent must change nothing. |
| **A failed send writes `failed` and the reason, and never leaves the row pending** | A card that still looks untouched after an SMTP error is a card whose next click sends the mail twice. |
| **Unscoped callers still send directly** | The master bearer and the user's own desktop client are the user. The boundary is the scope, not the tool. |
| **A cap on pending requests** | A model that misreads its instructions can call `message_send` in a loop. Past `MAX_PENDING` the tool refuses, which is also the signal the model needs: it is not being throttled, it is being told to stop. |

Implementation: `src/agent/approvals.ts` (queue, replay, card text),
`agent_approvals` in `src/db/store.ts` (the rows), `dispatch` in
`src/mcp/server.ts` (the gate), `POST /api/agent/approvals/:id` plus the
`approvals` SSE frame, `agent-approvals.tsx` (the card). Covered by
`test/mcp-scope.test.ts`.

## MVP surface

- Web: connect accounts, unified inbox, read, compose/send
- MCP tools: mail (`accounts_list`, `messages_list`, `messages_search`, `message_get`, `message_mark_read`, `folders_list`, drafts, `message_send`), chat (`chat_*`), plus CRM, automation and outreach groups
- CLI: `boxaide serve` | `boxaide mcp`

## Rejected for v0

Calendar, Superhuman polish, multi-tenant SaaS, agent-owned domains, Gmail OAuth as sole path.

## Response security headers

`src/api/security-headers.ts` runs as the first middleware in `createRuntime`, so the UI, the API, the MCP endpoint and every error response carry the same set. It only sets headers after the handler returns; it can never short-circuit a request.

| Header | What it closes |
|---|---|
| `Content-Security-Policy` | External script origins, framing, `<base>` injection, plugin content |
| `X-Frame-Options: DENY` | Clickjacking on browsers older than CSP L2 |
| `X-Content-Type-Options: nosniff` | A JSON body or an attachment being re-read as HTML |
| `Referrer-Policy: no-referrer` | A server URL, port and path leaking outward |
| `Permissions-Policy` | Camera, microphone, geolocation, payment, USB |
| `Cross-Origin-Opener-Policy` | Cross-origin window handles onto this page |

Two directives are deliberately looser than they look, and `SECURITY.md` states both as known limits:

- `script-src` allows `'unsafe-inline'`. A Next.js static export bootstraps hydration from an inline script and has no server to mint a per-response nonce. The origin restriction still holds. The control that actually stops sender-controlled markup is not this header at all: it is the four-layer fence over `bodyHtml`, stated once under "HTML mail rendering" in [SECURITY.md](../SECURITY.md#html-mail-rendering) and cited in the code as §6.4.6.
- `img-src` allows `https:`, because a srcdoc frame inherits the page policy and the reader's per-message "Load images" choice has to be expressible. The gate is the frame's own `<meta>` CSP, not this header. Plain `http:` stays blocked, the same line `connect-src` holds.
- `connect-src` allows loopback on any port plus `https:`. The Server URL is user-configurable — the page ships pointing at `127.0.0.1:8787` and is reachable on whatever port you launched. `'self'` alone blocks the app's own health check whenever those differ, which is a real failure caught in a browser, not a hypothetical. Plain `http:` to a remote host stays blocked.

The static deployment gets the same set from `apps/web/vercel.json`. Its `connect-src` is the same, since talking to your machine is the point.

## Agent work platform — CRM, automations, outreach

**Date:** 2026-08-13 · **Status:** accepted

Full spec: [docs/specs/agent-platform.md](specs/agent-platform.md). It owns the schema, the tool names, the REST paths and the derivation rules. This section records the decisions and does not repeat them.

Boxaide grows from an agentic inbox into a local agent work platform. Three modules ship together, all free, MIT and fully local, with no sync.

| Module | Directory | Owns |
|---|---|---|
| CRM | `src/crm/` | contacts, orgs, tags, notes, interactions, pipeline stages, deals |
| Automations | `src/automation/` | cron'd prompts, concurrent runs, run logs |
| Outreach | `src/outreach/` | campaigns, sequence steps, outbox, suppression |

Each module is a store, a service or engine, a `<MODULE>_TOOLS` + dispatcher pair, and a `register*Routes`. Nothing else in the tree changes shape.

### Decisions

| Decision | Reason |
|---|---|
| **No auto-send. Agent-written outreach lands in `outbox` as `pending`, and only REST approves it** | The failure this closes is not "the agent writes a bad email", it is "the agent decides for itself that the email was good". Approval is a different actor, reached over a different surface, in the browser. |
| **No MCP tool approves, rejects or sends an outbox row** | A tool that exists is a tool that can be called. Absence is the enforcement; a permission flag is not. `outbox_queue_draft` is the only route toward delivery, and its description says so to the agent. |
| **Suppression enforced in `MailService.sendMessage`, not in the outreach engine** | The engine is one caller of three. Putting the guard at the send seam covers manual compose and `message_send` as well, so there is no path that forgets. |
| **`overrideSuppression` is REST-only** | Overriding a "stop" is a human decision with a human's accountability. The MCP tool schema does not carry the flag, so an agent cannot pass it. |
| **Mail-derived text encrypted at rest, contact identity in plaintext** | Subjects, snippets, note text, campaign bodies, outbox bodies and run logs are mail content and get `_enc` columns via `encryptSecret`/`decryptSecret`. Emails, names, org names and domains stay plaintext because UNIQUE constraints and search need them, and because they are CRM data the user typed or the user's mail header carried in the clear anyway. |
| **CRM is derived from mail, not entered** | A CRM you have to fill in is a CRM that goes stale. `CrmService.syncFromMail` reads INBOX and Sent, so the contact list is a fact about your mail rather than a claim about it. Manual and agent-authored records are still allowed and are marked with `source`. |
| **Free email providers never create an organisation** | A gmail.com "organisation" with 400 unrelated contacts is worse than no organisation. The list is explicit, in the spec. |
| **One automation run at a time, in an in-process FIFO** | Runs are full agents with tool access to one SQLite file and one set of mailboxes. Concurrency here buys throughput nobody asked for and costs interleaved writes and duplicate outreach. |
| **A run is a one-shot headless CLI agent, not a model call from inside Boxaide** | Boxaide runs no model. That is true of the Agent view and stays true here: an automation reuses `AgentLauncher` and the same MCP wiring, so there is still no API key and no inference in this process. |
| **A run cannot talk to the user, and cannot send — but it can ask** | There is no one at the window at 03:00, so the pre-approved tool set omits the chat tools and the preamble says so. `message_send` is different: the run may call it, nothing goes out, and the request is waiting in the pane in the morning. That is the whole reason the approval queue is a stored row rather than a blocking prompt. |
| **Three kills: a 2-minute first-output watchdog (`error`), the 15-minute deadline (`killed`), a manual stop (`killed`) — each SIGKILL, each writing a note into the log** | An agent that hangs holds the queue, and the two hangs are not the same: one never started, so it is written off in two minutes as an error, while a run that already spoke and then overran is `killed` at the deadline. First stdout disarms the watchdog, because a healthy Claude run is silent for minutes inside one tool. A killed run with a log beats a stuck one, so every path leaves a line saying which kill it was. The run's duration is the honest one too — the launcher stops waiting 2s after the process is gone rather than on a grandchild that still holds a pipe. |
| **The CLI runs under a config home Boxaide owns, for chat as well as runs** | `--strict-mcp-config` only isolates MCP servers; hooks, skills, output styles and subagents still load, and a scheduled run was seen picking up the user's personal set. `CLAUDE_CONFIG_DIR` (and grok's `GROK_HOME`) point at `agent-homes/` under the agent root (`<dataDir>-agents`, deliberately outside the data dir), so the only things inherited are the ones auth needs: credentials, and the `env`/`apiKeyHelper` settings keys. The isolation is about whose config runs, not which path, so the chat agent gets it too. |
| **Automations have no create form in the web UI** | An automation is a prompt. Prompts are written by conversation and revision, and the agent that writes one is the agent that will run it. The empty state says exactly that and points at the Agent view. The UI owns everything after creation: enable, disable, next/last run, run now, log history, and which agent CLI and model carry the run. |
| **Claude Desktop scheduled tasks are imported by the agent, not by an importer** | `~/.claude/scheduled-tasks/*/SKILL.md` carries a name, a description and a body — everything `automation_create` needs except a cron. The agent reads the files with its own file tools and calls `automation_create` per task, asking for the schedule. Writing an importer would mean shipping a parser for another product's format and pretending the two execution contexts match. They do not: a Claude Desktop task may ask the user a question and touch the whole machine, a Boxaide automation may do neither. That rewrite is judgement, so it belongs to the agent and the user, in a conversation. |
| **Send throttling server-side: ≥60s gap with jitter, `BOXAIDE_SEND_DAILY_CAP` per account per UTC day** | Approval is per-message; deliverability is per-account. A human approving forty drafts in one sitting should not produce forty sends in one minute. Over the cap a row stays `approved` and goes the next day. |
| **Opt-out footer on every step including the first; no tracking pixels, no click redirects** | The privacy posture is the product. Tracking is out of scope, not deferred. |
| **Failed sends do not retry in v1** | A retry loop against SMTP without human eyes is how one bad address becomes a reputation problem. Status `failed` with the error recorded, and a human decides. |
| **Chats scope one global turn sequence; `seq` is never per-chat** | `seq` is the SSE resume cursor and the lease key. Numbering per chat would make both ambiguous, so `agent_chats` is a scope over the one sequence and a turn carries a `chat_id`. A message is claimed across all chats and the answer is written back to the chat that asked, not to whatever the user has since opened. |
| **Over budget archives the oldest chats; it never deletes and never touches the open one** | Conversation text is small, so this is not a disk valve — it is the guarantee that the store cannot grow without a number the user can see. Archiving drops the messages and keeps the record, so the list never silently loses rows. Deletion stays a human action. Per chat, 500 turns; across all chats, `BOXAIDE_CHAT_BUDGET_MB` (default 50). |
| **Rail sections fold, and a folded header keeps its count** | One sidebar, not two. The chat list would otherwise push the mailboxes off the bottom. Folding buys that room, and the rule that makes it safe is that no signal can hide inside a closed section — the CRM's approval count and the chat total stay on the header. The rail shows five chats whatever the history holds; the rest live in the all-chats dialog with the search box. |
| **Modules keep their own DDL and share the `Store` SQLite handle** | Same file, same WAL, same transaction semantics as the mail tables. `CREATE TABLE IF NOT EXISTS` in each store constructor means there is no migration step and no ordering requirement between modules. |
| **All module routes register inside `createApi` after the auth middleware** | The bearer token gates the platform exactly as it gates mail. There is no second auth model and no unauthenticated read. |

Residual risk: an automation run is a full agent with mail read access and CRM write access. It cannot send and cannot speak, but a prompt that says "summarise every message and put it in a note" will faithfully copy mail content into note rows — encrypted, but copied. Prompts are user-authored and that is the intended trade.

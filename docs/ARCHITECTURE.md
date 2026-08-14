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
| **`bodyHtml` is never rendered** | It is raw unsanitised sender HTML and there is no sanitiser in this codebase. The reader renders `bodyText` only; "View HTML source" shows it escaped inside a `<pre>`. `react/no-danger` is an ESLint **error**, so there is no `dangerouslySetInnerHTML` anywhere in the tree. |
| **`/api/agent-connect` is never called; `/api/local-bootstrap` only same-origin from loopback** | agent-connect embeds the token, and the MCP snippet is built client-side from `localStorage` instead. local-bootstrap exists precisely so the server's own UI needs no token copy-paste: the wizard calls it only when the page origin equals the server address and is loopback, mirroring the guard the endpoint itself enforces. A remotely hosted UI still requires a human to paste the token. |

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
| **`/api/local-bootstrap` deliberately not widened** | It is unauthenticated and returns the bearer token in plaintext. It exists only while the server's own bind address is loopback — `Host` and `Origin` are browser guards, and a remote client on a `0.0.0.0` bind chooses both headers itself, so `isLoopbackBindAddress(config.host)` is checked first and the route answers `404` otherwise. Beyond that it keeps the strict loopback-only `isAllowedOrigin` plus the `Host` check, and answers `Cache-Control: no-store` + `Vary: Origin` so neither the browser nor a local proxy retains the token. A remote UI must have its token pasted in by a human. |

Residual risk: allowlisting a hostname means anyone who can serve a page there — a preview deployment on a shared team, a hijacked account — can reach the server **if they also hold the token**. Prefer a custom domain over a platform-assigned hostname, and keep the list short.

Implementation: `parseAllowedOrigins` / `isApiOriginAllowed` / `applyCors` / `corsPreflight` in `src/api/routes.ts`, threaded through `AppConfig.allowedOrigins` (`src/config.ts`) into `createApi`, `/mcp` and `/health` (`src/app.ts`). Covered by `test/security-http.test.ts`.

## MVP surface

- Web: connect accounts, unified inbox, read, compose/send
- MCP tools: `accounts_list`, `messages_list`, `messages_search`, `message_get`, `message_send`
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

- `script-src` allows `'unsafe-inline'`. A Next.js static export bootstraps hydration from an inline script and has no server to mint a per-response nonce. The origin restriction still holds. The control that actually stops sender-controlled markup is that `bodyHtml` is never rendered and `react/no-danger` is an ESLint error.
- `connect-src` allows loopback on any port plus `https:`. The Server URL is user-configurable — the page ships pointing at `127.0.0.1:8787` and is reachable on whatever port you launched. `'self'` alone blocks the app's own health check whenever those differ, which is a real failure caught in a browser, not a hypothetical. Plain `http:` to a remote host stays blocked.

The static deployment gets the same set from `apps/web/vercel.json`. Its `connect-src` is the same, since talking to your machine is the point.

## Agent work platform — CRM, automations, outreach

**Date:** 2026-08-13 · **Status:** accepted

Full spec: [docs/specs/agent-platform.md](specs/agent-platform.md). It owns the schema, the tool names, the REST paths and the derivation rules. This section records the decisions and does not repeat them.

Boxaide grows from an agentic inbox into a local agent work platform. Three modules ship together, all free, MIT and fully local, with no sync.

| Module | Directory | Owns |
|---|---|---|
| CRM | `src/crm/` | contacts, orgs, tags, notes, interactions, pipeline stages, deals |
| Automations | `src/automation/` | cron'd prompts, serialized runs, run logs |
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
| **A run cannot talk to the user and cannot `message_send`** | There is no one at the window at 03:00. The fixed preamble says so, and the pre-approved tool set omits the chat tools and `message_send` so the statement is backed by the wiring. |
| **15-minute hard timeout, then SIGKILL and status `killed`** | An agent that hangs holds the queue. A killed run with a log is more useful than a stuck one. |
| **Automations have no create form in the web UI** | An automation is a prompt. Prompts are written by conversation and revision, and the agent that writes one is the agent that will run it. The empty state says exactly that and points at the Agent view. The UI owns everything after creation: enable, disable, next/last run, run now, log history. |
| **Claude Desktop scheduled tasks are imported by the agent, not by an importer** | `~/.claude/scheduled-tasks/*/SKILL.md` carries a name, a description and a body — everything `automation_create` needs except a cron. The agent reads the files with its own file tools and calls `automation_create` per task, asking for the schedule. Writing an importer would mean shipping a parser for another product's format and pretending the two execution contexts match. They do not: a Claude Desktop task may ask the user a question and touch the whole machine, a Boxaide automation may do neither. That rewrite is judgement, so it belongs to the agent and the user, in a conversation. |
| **Send throttling server-side: ≥60s gap with jitter, `BOXAIDE_SEND_DAILY_CAP` per account per UTC day** | Approval is per-message; deliverability is per-account. A human approving forty drafts in one sitting should not produce forty sends in one minute. Over the cap a row stays `approved` and goes the next day. |
| **Opt-out footer on every step including the first; no tracking pixels, no click redirects** | The privacy posture is the product. Tracking is out of scope, not deferred. |
| **Failed sends do not retry in v1** | A retry loop against SMTP without human eyes is how one bad address becomes a reputation problem. Status `failed` with the error recorded, and a human decides. |
| **Modules keep their own DDL and share the `Store` SQLite handle** | Same file, same WAL, same transaction semantics as the mail tables. `CREATE TABLE IF NOT EXISTS` in each store constructor means there is no migration step and no ordering requirement between modules. |
| **All module routes register inside `createApi` after the auth middleware** | The bearer token gates the platform exactly as it gates mail. There is no second auth model and no unauthenticated read. |

Residual risk: an automation run is a full agent with mail read access and CRM write access. It cannot send and cannot speak, but a prompt that says "summarise every message and put it in a note" will faithfully copy mail content into note rows — encrypted, but copied. Prompts are user-authored and that is the intended trade.

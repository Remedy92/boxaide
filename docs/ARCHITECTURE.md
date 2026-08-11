# Architecture decision — mailmux

**Date:** 2026-08-09  
**Status:** accepted

## Decision

Ship **mailmux** as a single **Node 22+ / TypeScript** process:

| Layer | Choice |
|-------|--------|
| HTTP | Hono |
| MCP | `@modelcontextprotocol/sdk` (Streamable HTTP + stdio CLI) |
| Receive | IMAP via **ImapFlow** |
| Send | SMTP via **Nodemailer** |
| State | SQLite (`better-sqlite3`) |
| Secrets | AES-256-GCM, master key file / `MAILMUX_MASTER_KEY` (64-hex verbatim, anything else stretched with scrypt) |
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

`apps/web` is a Next.js App Router build. It talks to the mailmux server from the browser, over HTTP, with a bearer token. The backend holds no UI state.

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

Deploying it to a static host (Vercel and equivalents): set the project's **Root Directory** to `apps/web`. Nothing in the repo can express that — it is a dashboard setting, and without it the platform builds the CLI package at the root instead. Then set `MAILMUX_ALLOWED_ORIGINS` on **your** machine to the deployed origin.

## Cross-origin access (`MAILMUX_ALLOWED_ORIGINS`)

**Date:** 2026-08-09 · **Status:** accepted

A browser page served from anywhere other than the mailmux process itself cannot reach `/api/*` by default. The `Origin` header must be absent (curl, MCP clients) or loopback; anything else is `403 forbidden origin`, and no `Access-Control-*` header is emitted at all.

`MAILMUX_ALLOWED_ORIGINS` adds exact origins to that gate so a separately hosted browser UI can call the local server directly. The decisions behind it:

| Decision | Reason |
|---|---|
| **Default empty (closed)** | Unset means byte-identical behaviour to before the change. Opening a service that holds decrypted IMAP passwords must be a deliberate act. |
| **Loopback stays implicitly allowed** | The same-origin static build needs no configuration. |
| **`*` parsed and dropped, never honoured** | The origin check is the surviving defence against DNS rebinding against a loopback service. `*` deletes it, and turns a leaked token into something usable from any page the user visits. |
| **`https:` only for non-loopback entries** | A plaintext allowlisted origin is trivially spoofed on a hostile network. |
| **Echo the *parsed* origin, never `*` and never the raw header** | A per-origin allowlist is meaningless without an exact echo, and it is a prerequisite for the `Vary` contract. The value comes from `new URL(origin).origin`, because the WHATWG parser reads a backslash as a slash: `https://good.example\.evil.com` passes the allowlist as `https://good.example`, and echoing the raw string back would hand the response to the attacker's origin. |
| **`Vary: Origin` on every response, including 401 and 403** | Without it a proxy, service worker or tunnel can serve one origin's answer to another. |
| **`Access-Control-Allow-Credentials` never sent** | mailmux authenticates by header, never by cookie. Ambient credentials must stay impossible. |
| **`Access-Control-Allow-Headers: authorization, content-type`** | Exactly what the client sends. Echoing the request's header list back would make the allowlist meaningless. |
| **Preflight answered before the auth gate** | An `OPTIONS` preflight carries no `Authorization` by spec, so gating it on the token makes CORS impossible. The origin allowlist is the control that applies; a preflight runs no handler and returns an empty 204. |
| **`/api/local-bootstrap` deliberately not widened** | It is unauthenticated and returns the bearer token in plaintext. It exists only while the server's own bind address is loopback — `Host` and `Origin` are browser guards, and a remote client on a `0.0.0.0` bind chooses both headers itself, so `isLoopbackBindAddress(config.host)` is checked first and the route answers `404` otherwise. Beyond that it keeps the strict loopback-only `isAllowedOrigin` plus the `Host` check, and answers `Cache-Control: no-store` + `Vary: Origin` so neither the browser nor a local proxy retains the token. A remote UI must have its token pasted in by a human. |

Residual risk: allowlisting a hostname means anyone who can serve a page there — a preview deployment on a shared team, a hijacked account — can reach the server **if they also hold the token**. Prefer a custom domain over a platform-assigned hostname, and keep the list short.

Implementation: `parseAllowedOrigins` / `isApiOriginAllowed` / `applyCors` / `corsPreflight` in `src/api/routes.ts`, threaded through `AppConfig.allowedOrigins` (`src/config.ts`) into `createApi`, `/mcp` and `/health` (`src/app.ts`). Covered by `test/security-http.test.ts`.

## MVP surface

- Web: connect accounts, unified inbox, read, compose/send
- MCP tools: `accounts_list`, `messages_list`, `messages_search`, `message_get`, `message_send`
- CLI: `mailmux serve` | `mailmux mcp`

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

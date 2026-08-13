# Sley — web interface

A Next.js App Router build of the Sley inbox. It is a **static export**: no route handlers, no server actions, no middleware, no proxy. Every byte of mail is fetched by the browser directly from the Sley server on the user's own machine, using a bearer token that lives in `localStorage` and is sent to no other origin.

This is a self-contained npm project with its own lockfile. The repo root stays the CLI package — do not add a `workspaces` key there, or `better-sqlite3` gets hoisted into this install.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
```

You will need a Sley server to talk to:

```bash
cd ../.. && ./scripts/start.sh --fixture   # http://127.0.0.1:8787, demo mailboxes
```

Then open the page, click **Set up Sley**, and paste the Server URL and the token `sley serve` printed. Talking to `127.0.0.1:8787` from `localhost:3000` is cross-origin but still loopback, so no `SLEY_ALLOWED_ORIGINS` entry is needed.

## Build

```bash
npm run build      # writes out/
npm run serve      # serves out/ statically
npm run lint
npx tsc --noEmit
```

There is no `next start`: `output: "export"` produces static files, and `next start` refuses to run against them.

## Deploy

Two supported paths, both documented in the root [README](../../README.md#using-the-hosted-interface):

- **Served by the Sley process** — `npm run web:build && npm run web:sync` from the repo root copies `out/` to `web-next/`, which `sley serve` prefers over the bundled `web/`. Same origin as the API: no CORS, no preflight, no Local Network Access prompt. The only path that works in Safari.
- **A static host** — set the project's Root Directory to `apps/web`, then set `SLEY_ALLOWED_ORIGINS` to the deployed origin on the machine running Sley.

`NEXT_PUBLIC_DEFAULT_API_BASE` is the only environment variable this app reads. It is optional, public, and sets nothing but the pre-filled Server URL default. No secret ever reaches the host — with a static export the platform is structurally incapable of seeing one.

## Layout

```
src/app/          layout.tsx (the only Server Component), page.tsx, globals.css
src/components/   app-shell, rail/, list/, reader/, dialogs/, ui/ (shadcn primitives)
src/lib/          types, settings, api/ (the only fetch), format/, hooks/
```

## Rules that are not negotiable

- **Never render `message.bodyHtml`.** It is raw unsanitised sender HTML and there is no sanitiser here. The reader renders `bodyText` only; "View HTML source" shows it escaped inside a `<pre>`. `react/no-danger` is an ESLint error, so `dangerouslySetInnerHTML` cannot land.
- **Never call `/api/agent-connect`.** Its response embeds the bearer token. The MCP snippet is built client-side from `localStorage`.
- **`/api/local-bootstrap` is called from one place, under one condition.** The setup wizard calls it only when the page's own origin IS the server address and that origin is loopback — the page is the server's own UI, so first run needs no token copy-paste. Served from anywhere else, a human pastes the token; the server enforces the same boundary.
- **Never fetch outside `src/lib/api/client.ts`.** It is the one place the token becomes an `Authorization` header, and the one place the base URL is resolved.
- **Only draw what the server can do.** Before adding a control, find its endpoint in `src/api/routes.ts`. There is no archive, delete, move, star, label, snooze, thread, attachment download, unread count or agent-presence signal, because there is no endpoint behind any of them. A greyed-out roadmap control is still a claim.

# Boxaide — web interface

A Next.js App Router build of the Boxaide inbox. It is a **static export**: no route handlers, no server actions, no middleware, no proxy. Every byte of mail is fetched by the browser directly from the Boxaide server on the user's own machine, using a bearer token that lives in `localStorage` and is sent to no other origin.

This is a self-contained npm project with its own lockfile. The repo root stays the CLI package — do not add a `workspaces` key there, or `better-sqlite3` gets hoisted into this install.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
```

You will need a Boxaide server to talk to:

```bash
cd ../.. && ./scripts/start.sh --fixture   # http://127.0.0.1:8787, demo mailboxes
```

Then open the page, click **Set up Boxaide**, and paste the Server URL and the token `boxaide serve` printed. Talking to `127.0.0.1:8787` from `localhost:3000` is cross-origin but still loopback, so no `BOXAIDE_ALLOWED_ORIGINS` entry is needed.

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

- **Served by the Boxaide process** — `npm run web:build && npm run web:sync` from the repo root copies `out/` to `web-next/`. That is the only UI `boxaide serve` looks for. Same origin as the API: no CORS, no preflight, no Local Network Access prompt. The only path that works in Safari.
- **A static host** — set the project's Root Directory to `apps/web`, then set `BOXAIDE_ALLOWED_ORIGINS` to the deployed origin on the machine running Boxaide.

`NEXT_PUBLIC_DEFAULT_API_BASE` is the only environment variable this app reads. It is optional, public, and sets nothing but the pre-filled Server URL default. No secret ever reaches the host — with a static export the platform is structurally incapable of seeing one.

## Layout

```
src/app/          layout.tsx (the only Server Component), page.tsx, app/,
                  install/, tray/, globals.css
src/components/   app-shell, rail/, list/, reader/, dialogs/, onboarding/,
                  agent/, automations/, crm/, outreach/, drafts/, atoms/, ui/
src/lib/          types, settings, api/ (the only fetch), format/, hooks/
```

## Rules that are not negotiable

- **Never render `message.bodyHtml`.** It is raw unsanitised sender HTML and there is no sanitiser here. The reader renders `bodyText` only; "View HTML source" shows it escaped inside a `<pre>`. `react/no-danger` is an ESLint error. The only `dangerouslySetInnerHTML` is the desktop UA marker in `layout.tsx`.
- **Never call `/api/agent-connect`.** Its response embeds the bearer token. The MCP snippet is built client-side from `localStorage`.
- **`/api/local-bootstrap` is desktop-only.** Loopback is not identity. The Electron shell puts a one-time capability in the URL fragment; the page strips and exchanges it. A normal browser pastes the token, even when served by Boxaide itself.
- **Never fetch outside `src/lib/api/client.ts`.** It is the one place the token becomes an `Authorization` header, and the one place the base URL is resolved.
- **Only draw what the server can do.** Before adding a control, find its endpoint in `src/api/routes.ts`. There is no archive, delete, move, star, label, snooze, thread or attachment download. Unread and agent presence do exist: `POST /api/messages/:accountId/:messageId/read`, `GET /api/agent/state`, `GET /api/agent/stream`, `GET /api/agents` plus start/stop.

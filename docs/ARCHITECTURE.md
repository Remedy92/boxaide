# Architecture decision — mailmux

**Date:** 2026-08-09  
**Status:** accepted

## Decision

Ship **mailmux** as a single **Node 20+ / TypeScript** process:

| Layer | Choice |
|-------|--------|
| HTTP | Hono |
| MCP | `@modelcontextprotocol/sdk` (Streamable HTTP + stdio CLI) |
| Receive | IMAP via **ImapFlow** |
| Send | SMTP via **Nodemailer** |
| State | SQLite (`better-sqlite3`) |
| Secrets | AES-256-GCM, master key file / `MAILMUX_MASTER_KEY` |
| Web | Static HTML/CSS/JS served by the same process |
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

## MVP surface

- Web: connect accounts, unified inbox, read, compose/send
- MCP tools: `accounts_list`, `messages_list`, `messages_search`, `message_get`, `message_send`
- CLI: `mailmux serve` | `mailmux mcp`

## Rejected for v0

Calendar, Superhuman polish, multi-tenant SaaS, agent-owned domains, Gmail OAuth as sole path.

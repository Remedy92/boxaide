# Security policy

## Reporting a vulnerability

Report privately through GitHub's [Report a vulnerability](https://github.com/Remedy92/mailmux/security/advisories/new) form. Do not open a public issue for a security bug.

Please include the version or commit, what an attacker gains, and the steps to reproduce. Expect a first reply within 7 days.

mailmux is a volunteer project with no paid support tier and no bug bounty.

## What mailmux protects

mailmux runs on your machine and holds live mail credentials. The threat model is a page you visit, a program on your machine, or a message a stranger sent you — not a compromised operating system.

| Asset | Protection |
|---|---|
| Mail passwords and OAuth tokens | AES-256-GCM at rest, per-record random nonce, authenticated. The master key lives in your data directory, never in the database. A `MAILMUX_MASTER_KEY` that is not 64 hex characters is a passphrase, stretched with scrypt (N=2¹⁷, r=8 — 128 MB per attempt) against a random per-install salt in `master.salt`, rather than hashed. |
| The bearer token | Compared in constant time. Accepted only in an `Authorization` header, never a query string. |
| The API | Bound to `127.0.0.1` by default. Every browser origin is denied except loopback and entries you add to `MAILMUX_ALLOWED_ORIGINS`. |
| `/api/local-bootstrap` | Hands out the token, so it answers `404` unless the server's own bind address is loopback. Beyond that it is gated on both the `Origin` and the `Host` header being loopback, sends `Cache-Control: no-store`, and carries no CORS headers. |
| Message bodies | Sender HTML is never rendered. The reader shows `bodyText` only, as React elements. There is no `dangerouslySetInnerHTML` anywhere in `apps/web` and `react/no-danger` is an ESLint error. |
| Links in messages | Only `https://`, `http://` and `mailto:` are linkified, so a `javascript:` URL stays inert text. Every link carries `rel="noopener noreferrer nofollow"`. |
| Every response | CSP with `frame-ancestors 'none'`, `base-uri 'none'` and `object-src 'none'`, plus `nosniff`, `Referrer-Policy: no-referrer` and a deny-all `Permissions-Policy`. |

## Known limits

These are deliberate. Report them only if you can show more impact than described.

- **`script-src` allows `'unsafe-inline'`.** The UI is a Next.js static export; its hydration bootstrap is inline and a static export cannot mint a per-response nonce. The origin restriction still holds, and the control that stops sender-controlled markup is that HTML bodies are never rendered.
- **`connect-src` allows loopback on any port and any `https:` origin.** The Server URL is yours to configure, so the policy has to permit what you configure. Plain `http:` to a remote host stays blocked.
- **`MAILMUX_ALLOWED_ORIGINS` accepts `https://` only, and ignores `*`.** A plaintext origin is spoofable on a hostile network, and an any-origin allowlist would let any page you visit reach your server. This is not a bug.
- **The scrypt salt sits beside the database in `master.salt`.** A salt is not a secret. An attacker who takes the database takes it too, and it still holds: no precomputed table works against a random per-install salt, and cracking one install teaches nothing about another. What stands between that attacker and the key is the passphrase and scrypt's cost. Delete the file and the key is no longer derivable — back it up with the data directory.
- **The bearer token is printed at startup when stdout is a terminal.** A human needs it on first run. Under a service manager or any other non-TTY stdout, the file path is printed instead, so log collectors do not retain the token.
- **Anything with write access to your data directory can read your mail.** The master key sits beside the database on purpose; mailmux has no passphrase prompt and no OS keychain integration.
- **A hosted deployment of `apps/web` has no server side.** No API routes, no server actions, no proxy. The host cannot see your token, your credentials or your mail.

## Supported versions

The `master` branch is the only supported version. mailmux is pre-1.0 and there are no backports.

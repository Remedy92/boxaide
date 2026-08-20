# Security policy

## Reporting a vulnerability

Report privately through GitHub's [Report a vulnerability](https://github.com/Remedy92/boxaide/security/advisories/new) form. Do not open a public issue for a security bug.

Please include the version or commit, what an attacker gains, and the steps to reproduce. Expect a first reply within 7 days.

Boxaide is a volunteer project with no paid support tier and no bug bounty.

## What Boxaide protects

Boxaide runs on your machine and holds live mail credentials. The threat model is a page you visit, a program on your machine, or a message a stranger sent you — not a compromised operating system.

| Asset | Protection |
|---|---|
| Mail passwords and OAuth tokens | AES-256-GCM at rest, per-record random nonce, authenticated. The master key lives in your data directory, never in the database. A `BOXAIDE_MASTER_KEY` that is not 64 hex characters is a passphrase, stretched with scrypt (N=2¹⁷, r=8 — 128 MB per attempt) against a random per-install salt in `master.salt`, rather than hashed. `SLEY_MASTER_KEY` then `MAILMUX_MASTER_KEY` are still read when `BOXAIDE_MASTER_KEY` is unset. |
| The bearer token | Compared in constant time. Accepted only in an `Authorization` header, never a query string. |
| The API | Bound to `127.0.0.1` by default. Every browser origin is denied except loopback and entries you add to `BOXAIDE_ALLOWED_ORIGINS`. |
| `/api/local-bootstrap` | Hands out the token, so it answers `404` unless the server's own bind address is loopback. `Host` must be loopback. A missing `Origin` is allowed (curl, MCP); a present `Origin` must be loopback. Sends `Cache-Control: no-store`, and carries no CORS headers. |
| Message bodies | Sender HTML renders only after DOMPurify, only inside an `<iframe srcdoc>` whose `sandbox` omits both `allow-scripts` and `allow-same-origin`, and whose own CSP is `default-src 'none'`. Four independent layers: sanitised, script-forbidden, opaque-origin (no app DOM, no `localStorage`, no token even for script that cannot run), and fetch-fenced. Remote images are blocked per message until the user opts in; tracking pixels load nothing by default. It never enters the React tree: `react/no-danger` is an ESLint error, and the one `dangerouslySetInnerHTML` in `apps/web` is a fixed desktop UA marker in `layout.tsx`, not mail. |
| Forwarded HTML | A forward carries the source message's HTML part only after the same DOMPurify pass the reader uses, and only as an addition: the plain-text body is always built and always sent. What this client refuses to run, it refuses to relay. One click drops it. |
| Links in messages | Only `https://`, `http://` and `mailto:` are linkified, so a `javascript:` URL stays inert text. Every link carries `rel="noopener noreferrer nofollow"`. |
| Every response | CSP with `frame-ancestors 'none'`, `base-uri 'none'` and `object-src 'none'`, plus `nosniff`, `Referrer-Policy: no-referrer` and a `Permissions-Policy` that denies camera, microphone, geolocation, payment, USB and `interest-cohort`. |

## Known limits

These are deliberate. Report them only if you can show more impact than described.

- **`script-src` allows `'unsafe-inline'`.** The UI is a Next.js static export; its hydration bootstrap is inline and a static export cannot mint a per-response nonce. The origin restriction still holds, and the control that stops sender-controlled markup is that HTML bodies render only sanitised inside a script-disabled sandboxed frame.
- **`img-src` allows `https:`.** A srcdoc frame inherits the page policy, so a header that banned remote images would overrule the reader's per-message "Load images" choice. The default block lives in the frame's own `<meta>` CSP (`img-src data:`), which widens only when the user asks. Plain `http:` to a remote host stays blocked, so mail that hot-links images over plaintext shows nothing.
- **DOMPurify sits on the path that sender HTML takes.** Rendering HTML at all means trusting a third-party parser, and its bypass history is not empty. It is layer one of four: a bypass still lands in a frame that cannot run script, has no origin, and can fetch nothing. The dependency is pinned in `apps/web/package-lock.json` and is worth watching.
- **Printing an HTML message captures only what is on screen.** The frame is an opaque origin, so the parent cannot measure its content height and cannot expand it for print. Fixing it means a same-origin frame, which is the trade this design refuses.
- **Rendered HTML mail makes convincing phishing possible.** A plain-text reader structurally cannot show a sender's forged letterhead. This one can. No sanitiser addresses that, and no layer here does either. Judge the sender, not the rendering.
- **`connect-src` allows loopback on any port and any `https:` origin.** The Server URL is yours to configure, so the policy has to permit what you configure. Plain `http:` to a remote host stays blocked.
- **`BOXAIDE_ALLOWED_ORIGINS` accepts `https://` only, and ignores `*`.** A plaintext origin is spoofable on a hostile network, and an any-origin allowlist would let any page you visit reach your server. This is not a bug.
- **The scrypt salt sits beside the database in `master.salt`.** A salt is not a secret. An attacker who takes the database takes it too, and it still holds: no precomputed table works against a random per-install salt, and cracking one install teaches nothing about another. What stands between that attacker and the key is the passphrase and scrypt's cost. Delete the file and the key is no longer derivable — back it up with the data directory.
- **The bearer token is printed at startup when stdout is a terminal.** A human needs it on first run. Under a service manager or any other non-TTY stdout, the file path is printed instead, so log collectors do not retain the token.
- **Anything with write access to your data directory can read your mail.** The master key sits beside the database on purpose; Boxaide has no passphrase prompt and no OS keychain integration.
- **A hosted deployment of `apps/web` has no server side.** No API routes, no server actions, no proxy. The host cannot see your token, your credentials or your mail.

## Supported versions

The `master` branch is the only supported version. Boxaide is pre-1.0 and there are no backports.

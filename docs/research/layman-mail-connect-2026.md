# Layman mail connect options (2026)

Research date: 2026-08-10. Primary sources preferred (Google, Microsoft, product docs). Unofficial costs and timelines are marked.

## Executive answer

**No.** A non-developer cannot get Superhuman / Apple Mail / Outlook-class “Sign in with Google” UX into a product like mailmux without **someone else** owning a production OAuth client (and, for Gmail restricted mail scopes, Google verification + usually CASA).

| What the layperson does | Who paid the verification cost | Works for strangers? |
| --- | --- | --- |
| App password + IMAP form (mailmux today) | Nobody | Partially — fails often (2SV, Workspace policy, Advanced Protection) |
| “Sign in with Google” using **mailmux’s** OAuth client | mailmux project (or a paid proxy that already verified) | Yes, after Google production verification |
| User creates their own Google Cloud project | Each user | Yes for that user only — **not** layman UX |
| Nylas / Unipile (or similar) connect proxy | SaaS vendor (+ often your own app still) | Yes — paid, not zero-SaaS-core |

**Decision for mailmux:** ship **Path D (hybrid)** as the product target — OAuth presets for Gmail/Microsoft, keep IMAP/app-password for Fastmail/generic/advanced. Path A stays the zero-dependency core. Path B is the hard part (verification, not code). Path C is an optional plug-in for people who will not run verification themselves.

**Critical architecture fork:** Gmail **IMAP XOAUTH2** requires `https://mail.google.com/`. Google treats that as a **restricted** scope and, in verification FAQ language, steers apps that do not need permanent delete-bypassing-trash toward the **Gmail API** and narrower restricted scopes. Staying IMAP-only for Gmail makes verification harder and may be rejected on least-privilege grounds. Microsoft is cleaner: IMAP XOAUTH2 **or** Graph are both documented first-class paths.

## Consumer UX baseline

What “good” looks like (Apple Mail, Superhuman, Spark, modern Outlook, iOS Gmail):

1. User clicks **Connect Gmail** / **Sign in with Microsoft**.
2. System browser opens the provider consent screen (account picker, 2SV already handled by Google/Microsoft).
3. User sees the **app name**, requested permissions, and Accept.
4. Browser returns to the app. Mail starts syncing. No hostnames, ports, or 16-digit codes.
5. Token refresh is invisible until revoke/password-change; then one-click re-auth.

What “bad” (developer / power-user) looks like:

- Enable 2-Step Verification → App passwords → copy 16 chars → paste into a form → hope IMAP is allowed.
- Create a Google Cloud project → enable APIs → OAuth consent screen → create credentials → download JSON → paste client id/secret into self-hosted config.
- Weekly re-auth because the OAuth app is still in **Testing**.

mailmux today is the second column for Gmail/Outlook personal accounts (app passwords). That is fine for developers and Fastmail users. It is not consumer UX.

## Why app passwords fail non-developers

Primary Google guidance:

- App passwords exist for **legacy apps that do not support Sign in with Google**.
- They require **2-Step Verification** on the account.
- Google **does not recommend** them; prefers OAuth (“Sign in with Google”).
- They are **invisible or unavailable** when:
  - 2SV is off
  - 2SV is security-key-only
  - Account is on **Advanced Protection**
  - User is on a **work/school (Workspace)** account and the admin path does not expose them
- Workspace: app passwords **bypass 2SV**; admins are steered away from them; **enforcing security keys disables app passwords**.

Microsoft / consumer Outlook: basic auth is largely retired for Exchange Online; modern clients use OAuth. App passwords are not the mainstream path for personal Microsoft accounts either.

**Product implication:** documenting “create an app password” will always lose Superhuman-class users and a large fraction of Workspace users. Keep it as advanced fallback, not the Gmail/Outlook primary path.

## Technical options (table + detail)

| Path | Layman UX | Per-user developer setup? | Core stays free of paid SaaS? | Verification burden | Fits multi-provider IMAP stack? |
| --- | --- | --- | --- | --- | --- |
| A. App passwords only (current) | Poor for Gmail/Outlook | Low technical, high friction | Yes | None | Yes (current) |
| B. mailmux-owned OAuth client (desktop/public + PKCE or hosted relay) | Good after verification | No for end user | Yes for core | **High** (Google restricted; Microsoft lighter) | Partial — Gmail may need Gmail API |
| C. Paid connect proxy (Nylas, Unipile, …) | Good | No | **No** for that path | Vendor / contract add-on | Via their API, not raw IMAP |
| D. Hybrid (OAuth presets + IMAP advanced) | Good for big two; OK elsewhere | No for presets | Yes if B is self-run | Same as B for presets | Yes |
| E. Each self-hoster brings own OAuth client | Good only for that hoster | **Yes — worse than app passwords** | Yes | Each operator | Yes |
| F. Self-hosted EmailEngine-style side process | Good if someone configured OAuth once | Admin-level | Yes (self-host binary; license TBD) | Same as B if shared client | Yes (proxy/API) |

### Google: Gmail API OAuth vs IMAP XOAUTH2

**IMAP/SMTP/POP XOAUTH2**

- Scope: **`https://mail.google.com/`** only (for standard user OAuth).
- Mechanism: SASL XOAUTH2, `user=…\x01auth=Bearer <token>\x01\x01`, base64.
- Compatible with ImapFlow-style stacks **if** the library supports XOAUTH2 (token, not password).
- Google docs: full mail scope must comply with API Services User Data Policy; show full utilization of `mail.google.com/`; otherwise migrate to Gmail API with granular restricted scopes.
- Official restricted-scope list **explicitly includes** `https://mail.google.com/` and notes it covers IMAP/SMTP/POP3.
- Google OAuth FAQ (IMAP/SMTP): requesting `mail.google.com/` only for SMTP send can **violate minimum-scope policy**; migrate to `gmail.send` via Gmail API. For IMAP, if you do not need permanent delete bypassing trash, they push **Gmail API + less permissive scopes**.

**Gmail API OAuth**

- Scopes of interest for a full inbox agent:
  - Restricted: `gmail.readonly`, `gmail.modify`, `gmail.compose`, …
  - Sensitive: `gmail.send` (send-only)
  - Restricted full: `https://mail.google.com/` (permanent delete beyond trash — avoid unless required)
- Least privilege for read+label+send without permanent purge: typically **`gmail.modify`** (and maybe `gmail.send` depending on design) — still **restricted**, so still full verification path, but more defensible than `mail.google.com/`.
- Requires a Gmail API client in mailmux (not only ImapFlow). That is a second mail backend for Gmail, not a small auth tweak.

### Microsoft: Graph vs IMAP XOAUTH2

Both are first-class:

1. **IMAP/POP/SMTP OAuth** (legacy protocols with modern auth)
   - Scopes: `https://outlook.office.com/IMAP.AccessAsUser.All`, `…/SMTP.Send`, plus `offline_access` for refresh.
   - Same SASL XOAUTH2 shape as Gmail.
   - Works for Microsoft 365 and Outlook.com per Microsoft docs.
2. **Microsoft Graph**
   - Delegated `Mail.Read` / `Mail.ReadWrite` / `Mail.Send` (+ `offline_access`).
   - Better long-term product surface (folders, delta, categories) if you invest in a Graph provider.
3. **App registration**
   - Entra app (multi-tenant + personal accounts if you want Outlook.com).
   - Public client / desktop: loopback `http://localhost` (or port) is supported for system-browser flows.
   - No Google-style “CASA for mail scopes” product gate documented the same way; enterprise admin consent still applies for tenants that restrict third-party apps.

### Hosted connect proxies (patterns only)

**Nylas (official docs)**

- Hosted OAuth → **grant**; app keeps API key + `grant_id`; Nylas refreshes provider tokens.
- Default advice: create **your own** Google/Microsoft provider apps; verification still applies before go-live.
- **Shared GCP App** (contract add-on): users auth through Nylas-owned pre-verified GCP project — skip your verification/CASA. Paid product, not open-core.

**Unipile (vendor docs)**

- Hosted auth link; optional use of Unipile’s pre-verified Google credentials so the integrator skips CASA.
- Same class of tradeoff: mail/token path goes through a third party; costs money; conflicts with “zero paid SaaS for core.”

**EmailEngine (self-hosted pattern)**

- Self-hosted email API: OAuth for Gmail/M365, IMAP for generic, hosted authentication form, optional IMAP proxy for password-only clients.
- Does **not** remove Google verification: someone must still attach a production OAuth client. Useful as architecture reference (token vault + proxy), not as free verification.

### Desktop / native OAuth for self-hosted on `127.0.0.1`

Google’s installed-app flow is the sanctioned model:

1. OAuth client type: **Desktop app** (installed application).
2. App opens the **system browser** to `https://accounts.google.com/o/oauth2/v2/auth`.
3. **PKCE** (`code_verifier` / `code_challenge`, S256 recommended).
4. **Loopback redirect**: app listens on `http://127.0.0.1:<port>` or `http://[::1]:<port>`; Google redirects with `code`.
5. App exchanges code for access + **refresh** token; stores refresh token locally.
6. Google documents that installed apps **cannot keep secrets**; client secret for desktop is “obviously not treated as a secret” when embedded.

Microsoft parallel: public client + system browser + `http://localhost` redirect; MSAL patterns.

**mailmux shape:** local Node process already binds `127.0.0.1:8787`. OAuth loopback can use that origin or a short-lived extra port. No public HTTPS domain required for the **redirect** on desktop/public clients. A separate **hosted auth relay** is only needed if you insist on a confidential web client (client secret server-side) for every self-hoster — worse fit for local-first.

## Google OAuth verification reality

### Scope classes that matter for mailmux

| Scope | Class (Gmail API docs / restricted list) | Typical use |
| --- | --- | --- |
| `https://mail.google.com/` | **Restricted** (IMAP/SMTP/POP) | IMAP XOAUTH2 |
| `gmail.readonly`, `gmail.modify`, `gmail.compose`, … | **Restricted** | Gmail API inbox |
| `gmail.send` | **Sensitive** | Send-only API |
| `openid` / `email` / `profile` | Non-sensitive identity | Account picker only |

Restricted ⇒ full verification path. Sensitive ⇒ verification without the full restricted package. Brand verification is separate (name, logo, domains).

### External users vs test / personal use

From Google production-readiness + “when verification is not needed”:

| Mode | Who can sign in | Unverified / testing UI | Refresh token lifetime (non-basic scopes) | Cap |
| --- | --- | --- | --- | --- |
| **Testing** + External | Allowlisted **test users only** (≤100) | Testing warning UI | **7 days** (official OAuth2 expiration rules) | 100 test users |
| **Published** + External + **Unverified** | Any Google user (discouraged) | “Unverified app” / Danger UI for sensitive/restricted | Production-like tokens, but **100 total user hard cap** for sensitive/restricted unverified | 100 lifetime users |
| **Published** + External + **Verified** | Any Google user | Normal consent | Long-lived refresh (until revoke / 6 months unused / policy events) | No 100-user verification cap |
| **Internal** (Workspace org only) | Org users only | N/A | Org policies apply | No public verification |
| **Personal use** exception | &lt;100 users | Unverified click-through allowed | Still subject to testing rules if status is Testing | Verification required to grow past 100 |

**Product-killer for “ship OAuth without verification”:** Testing refresh tokens **expire in 7 days** when scopes are not just basic identity. That is unusable for a local always-on inbox. Unverified production still hits the **100-user lifetime cap** and scary consent UI.

### Official timeline estimates (Google FAQ)

| Step | Google’s stated estimate | Notes |
| --- | --- | --- |
| Brand verification | 2–3 business days | Domain ownership, homepage, privacy policy |
| Sensitive scope verification | ~10 business days | e.g. `gmail.send` alone |
| Restricted scope verification | ~6 weeks | Includes policy review; **security assessment** when required |
| Annual re-verification | Annual | Restricted scopes / LOA recert |

Estimates are **not guarantees**; depend on developer responsiveness and whether Google rejects least-privilege / Limited Use.

### CASA / security assessment

- Restricted scopes that **store or transmit** restricted data **on servers** require an annual security assessment under the **App Defense Alliance CASA** framework.
- Google **does not charge** a fee; **authorized assessors** do. Cost is private between developer and lab (not published by Google). Community reports vary widely (hundreds USD for Tier 2 self-scan + validation up to much higher for full lab work) — treat dollar amounts as **uncertain**.
- If mailmux is **purely local** (tokens + mail cache only on the user’s machine, no mailmux-operated backend that sees mail), argue **no third-party server** holds restricted data. Uncertainty: Google still requires restricted-scope verification for external users; whether CASA is waived for pure desktop local-only is **not clearly free** in the docs — mark as open with Trust & Safety when submitting. A **hosted auth relay that only sees OAuth codes/tokens** is still a third-party server for secrets, if not for mail bodies.
- Self-hosted multi-user deployments where an operator’s server holds many users’ Gmail tokens **look like** the CASA “server stores restricted data” case.

### Limited Use and agentic / MCP products (policy risk)

Google API Services User Data Policy + Workspace AI clarifications (FAQ):

- Restricted-scope data: **Limited Use** — only user-facing features disclosed in the privacy policy; no ads, no data brokers, no training **foundational / frontier** models on Gmail content.
- Personalized / on-device / single-user models for a user-directed feature are treated differently from training shared foundation models.
- **mailmux MCP agents** that send full mailbox content to arbitrary third-party LLMs need careful product design and privacy-policy wording. Risk of verification rejection or later suspension if “agent” implies unrestricted export of mail to external model trainers.

### Workspace admins

Even a verified external app can be **blocked, limited, or trusted** per tenant. Verification does not override Admin API controls. Enterprise Workspace users may still fail to connect until an admin allowlists the app.

## Microsoft path (brief)

1. Register multi-tenant (and personal Microsoft account if desired) Entra app.
2. Public client for local mailmux; confidential client only if you run a real backend.
3. Prefer **authorization code + PKCE + offline_access**.
4. For least change to ImapFlow: IMAP XOAUTH2 scopes on `outlook.office.com`.
5. For better product: Graph `Mail.ReadWrite` + `Mail.Send`.
6. Tenant admin consent / service principals only needed for **app-only** (client credentials) mailbox access — not for normal “user signs in” desktop flow.
7. No Google-equivalent public CASA for Graph mail scopes; still need correct publisher branding and enterprise-friendly consent strings.

Outlook.com + M365 consumer UX can match Gmail OAuth once the Entra app is production-ready. Cost is mostly engineering + support, not a security assessment market.

## Fit to mailmux principles

From product stance (`README`: MIT, self-hosted, **no paid SaaS required for core** receive+send, local process, multi-mailbox, MCP for agents):

| Principle | A App passwords | B Own OAuth | C Paid proxy | D Hybrid |
| --- | --- | --- | --- | --- |
| MIT / open core | Yes | Yes (client id is config, not proprietary lock) | Plug-in only | Yes |
| Zero paid SaaS for **core** | Yes | Yes | **Breaks** if core depends on it | Yes if OAuth is self-run |
| Local-first | Yes | Yes (tokens on disk; loopback) | No (mail via vendor) | Yes |
| Multi-provider | Yes | Gmail/MS first; IMAP remains | Vendor matrix | Best |
| MCP agents reuse one store | Yes | Yes | Possible via adapter | Yes |
| Layman Gmail/Outlook | No | Yes **after** verification | Yes | Yes |

**Tension:** “Sign in with Google for any stranger who `npm install`s mailmux” **requires** a project-owned verified client (Path B). That is operational cost on the **maintainer**, not on the user. It does not force a paid SaaS into the data path if tokens stay local.

**Tension:** Google Limited Use vs “any MCP tool may read mail and ship it to any model.” Product policy must constrain default agent behavior or verification and ToS risk rise.

## Recommended product path

### Ranking

1. **Path D — hybrid (recommended)**  
   - UI: **Connect Gmail** / **Connect Microsoft** (OAuth) + **Other IMAP** (hosts + password/app password).  
   - Implementation phase 1: Microsoft IMAP XOAUTH2 or Graph (lower policy wall).  
   - Implementation phase 2: Gmail via **Gmail API** provider (prefer over IMAP XOAUTH2 for verification).  
   - Keep Path A code paths for Fastmail, iCloud, generic.

2. **Path B — mailmux-owned OAuth (required substrate for D)**  
   - One Desktop (or public) client embedded/configurable; loopback PKCE on the local server.  
   - Maintainer runs Google verification when ready for public Gmail OAuth.  
   - Until verified: OAuth feature behind “dev/test users only” or disabled in release notes — do not ship broken 7-day tokens as production UX.

3. **Path A — keep as core forever**  
   - Default for providers that still use passwords; zero Google dependency; offline demos; fixture mode.

4. **Path C — optional plug-in only**  
   - `provider: nylas | unipile` for operators who want managed grants and will pay.  
   - Never required for core README quickstart.

5. **Path E — per-user Cloud Console**  
   - Reject as primary UX. Optional advanced “bring your own client id” for orgs that must use Internal apps.

### Path B — how `127.0.0.1` Node does OAuth without each user creating a Cloud project

```
User clicks Connect Gmail
        │
        ▼
mailmux (local) generates PKCE verifier/challenge
opens system browser → Google authorize URL
  client_id = mailmux production desktop client
  redirect_uri = http://127.0.0.1:<port>/oauth/google/callback
  scope = gmail.modify … (or mail.google.com if IMAP — not preferred)
  access_type=offline&prompt=consent (first time, for refresh_token)
        │
        ▼
User consents in browser
        │
        ▼
Google redirects to loopback → local HTTP handler
exchanges code + code_verifier → access_token + refresh_token
        │
        ▼
Store refresh_token with existing AES-GCM secret store (~/.mailmux)
Refresh access_token before IMAP/API calls; re-auth UX on invalid_grant
```

**What each user does *not* do:** open Google Cloud Console, create OAuth clients, or paste client secrets.

**What the mailmux project must do:**

1. Own a Google Cloud project + branding (homepage, privacy policy URL, support email).
2. Create **Desktop** OAuth client; ship `client_id` (and desktop client secret if Google still requires it on token endpoint — treat as public).
3. Complete brand + restricted scope verification before marketing “Sign in with Google.”
4. Answer Limited Use / data handling for local storage + MCP.
5. Expect annual re-verification / possible CASA if Google classifies the deployment as server-held restricted data.
6. Optional: allow override env `MAILMUX_GOOGLE_CLIENT_ID` for BYO / Internal Workspace apps.

**Hosted auth relay variant (usually worse for mailmux):** a small public HTTPS service that holds the confidential client secret and returns tokens to localhost. Adds ToS surface, availability dependency, and a server that sees refresh tokens — only justified if Desktop client type is rejected for your verification package (unlikely if you truthfully ship a local app).

### Token storage (local-first)

- Prefer same secret vault as app passwords today (AES-256-GCM at rest).
- Store: provider, account email, refresh_token, scope set, expiry metadata.
- Never log tokens; never put refresh tokens in MCP tool responses.
- On `invalid_grant`: surface “Reconnect Gmail” in UI (consumer pattern).

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Google rejects IMAP `mail.google.com/` as not least privilege | High for IMAP-only OAuth | Prefer Gmail API provider; document dual backend |
| 7-day refresh tokens if left in Testing | High product bug | Do not ship Gmail OAuth as “done” until Published+Verified |
| 100-user cap unverified | High | Same |
| Shared client_id abused / app impersonation | Medium | Desktop + PKCE; monitor OAuth abuse; App Check where applicable |
| Google revokes or suspends the project OAuth client | High (all users re-auth or stuck) | Incident process; BYO client id escape hatch; status page |
| Refresh token theft on disk | High (full mailbox) | OS file perms, existing encryption, optional OS keychain later |
| Workspace admin blocks app | Medium | Clear error copy; admin allowlist docs |
| Limited Use vs MCP → third-party LLM training | High policy | Default agents local/user-directed; privacy policy; no training claims |
| Client secret in open source Desktop client | Accepted by Google for installed apps | PKCE; no confidential-web pretence |
| CASA cost / annual load on maintainers | Medium–High | Delay public Gmail OAuth; start Microsoft; local-only legal argument |
| Microsoft tenant policies / admin consent | Medium | Support message + Graph error mapping |

## Open decisions

1. **Gmail transport:** Gmail API (verification-friendly, more code) vs IMAP XOAUTH2 (fits ImapFlow, harder verification)? **Lean Gmail API for public OAuth.**
2. **When to start Google verification:** only after a real homepage, privacy policy, and demo video exist for reviewers.
3. **CASA applicability** to pure local single-user desktop: confirm with Google Trust & Safety at submission; do not assume free pass.
4. **MCP default tools:** does “read mail for summarization via user-chosen model endpoint” stay Limited Use? Needs explicit policy text before verification.
5. **Ship Microsoft OAuth first?** Lower gate; validates loopback UX without CASA.
6. **Path C plug-in:** build only if a user segment demands managed grants; keep out of core.
7. **BYO OAuth client env vars:** yes for enterprises (Internal apps); secondary docs.

## Sources

### Google (primary)

- [Gmail IMAP/SMTP XOAUTH2 protocol](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol) — scope `https://mail.google.com/`, SASL format, User Data Policy note.
- [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2) — installed apps; **Testing → 7-day refresh tokens**; 100 refresh tokens per user per client.
- [OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app) — PKCE, loopback redirect, installed app assumptions.
- [Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) — sensitive vs restricted; `mail.google.com/` vs granular Gmail scopes; security assessment if restricted data on servers.
- [Restricted scopes list](https://support.google.com/cloud/answer/13464325) — `https://mail.google.com/` includes IMAP/SMTP/POP3; `gmail.readonly` / `gmail.modify` restricted.
- [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) — exceptions, security assessment, timelines.
- [OAuth app state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview) — Testing / Published / Internal; 100 test users; unverified Danger UI.
- [When is verification not needed](https://support.google.com/cloud/answer/13464323) — personal use &lt;100; testing; internal.
- [OAuth App Verification FAQ](https://support.google.com/cloud/answer/13463817) — brand 2–3 days; sensitive ~10 days; restricted ~6 weeks; IMAP/SMTP minimum-scope guidance; CASA fees not charged by Google.
- [Security assessment (CASA)](https://support.google.com/cloud/answer/13465431) — annual assessment; App Defense Alliance.
- [CASA overview](https://appdefensealliance.dev/casa) / [authorized assessors](https://appdefensealliance.dev/casa/casa-assessors).
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) — Limited Use, minimum scopes, secure handling.
- [Sign in with app passwords](https://support.google.com/mail/answer/185833) — 2SV required; not recommended; prefer Sign in with Google.
- [How 2SV works with legacy apps (Workspace)](https://knowledge.workspace.google.com/admin/security/how-2-step-verification-works-with-legacy-apps) — app passwords bypass 2SV; security keys disable them.

### Microsoft (primary)

- [Authenticate IMAP/POP/SMTP with OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth) — scopes, XOAUTH2, M365 + Outlook.com.
- [Microsoft Graph permissions overview](https://learn.microsoft.com/en-us/graph/permissions-overview) — delegated vs application; personal accounts.
- [Desktop app configuration (identity platform)](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration) — public client, `http://localhost` redirect.

### Connect proxies (product docs only — not Google policy authority)

- [Nylas authentication](https://developer.nylas.com/docs/v3/auth/) — hosted OAuth, grants; Shared GCP App as paid skip-verification path.
- [Nylas Google verification guide](https://developer.nylas.com/docs/provider-guides/google/google-verification-security-assessment-guide/) — restates Google sensitive vs restricted.
- [Unipile email overview](https://developer.unipile.com/docs/emails) / marketing OAuth pages — hosted connect; optional vendor Google credentials.
- [EmailEngine](https://emailengine.app/) / [OAuth2 configuration](https://learn.emailengine.app/docs/configuration/oauth2-configuration) — self-hosted OAuth + IMAP proxy pattern.

### mailmux context

- `README.md` (this repo) — MIT; no paid SaaS for core; app-password connect flow; ImapFlow/Nodemailer; local secrets.

---

*Uncertainty markers:* CASA waiver for pure local single-user desktop; exact assessor pricing; whether Google verification will accept an open-source local agentic inbox under Limited Use without product constraints on MCP export; Microsoft personal-account edge cases for specific Graph permissions over time.

# Agent platform spec — CRM, automations, outreach

**Date:** 2026-08-13 · **Status:** accepted · **Author:** Fable (with Lucas)

Boxaide grows from agentic inbox into a local agent work platform. Three modules
ship together: a CRM derived from mail, scheduled agent automations, and an
outreach engine with human approval. All free, MIT, fully local. No sync.

## Non-negotiable invariants

1. **No auto-send.** Agent-written outreach lands in the `outbox` table with
   status `pending`. Only a human, through the web UI (REST), approves. There
   is **no MCP tool** that approves, rejects, or sends outbox rows — an agent
   must never approve its own email.
2. **Suppression is enforced server-side.** `MailService.sendMessage` calls a
   send guard. A recipient on the suppression list fails the send with error
   `recipient suppressed: <email>` unless the caller passes
   `overrideSuppression: true` (a human decision; the MCP `message_send` tool
   does NOT expose that flag).
3. **Mail content is never at rest in plaintext.** Any column that carries
   message-derived text (subjects, snippets, bodies, notes, run logs) is
   encrypted with the master key via `encryptSecret`/`decryptSecret`
   (`src/crypto/secrets.ts`), suffix `_enc`. Contact identity fields (email,
   name, org name/domain) stay plaintext — they are needed for UNIQUE and
   search and are CRM data, not mail bodies.
4. **One automation agent at a time.** Automation runs are serialized in a
   queue. A run that is still going when the next fires makes the next wait.
5. **Send throttling is server-side.** Approved outreach sends respect a
   per-account daily cap (`BOXAIDE_SEND_DAILY_CAP`, default 50) and a minimum
   gap of 60s with jitter between engine-driven sends.
6. **Module isolation.** Each module lives in its own directory and touches
   shared files only through the seams already wired (see File map). Do not
   edit another module's directory.
7. **Contact state is derived, never asserted by an agent.** Whether someone
   was contacted, replied, or opted out is worked out from the rows written by
   whatever performed the act — the mail sync, the outreach engine, opt-out
   detection. No tool writes it. The one exception is intent (`queued`,
   `do_not_contact`), which no past mail could imply; it is stored in
   `contact_intent`, one row per contact, replace-on-write.

### Contact state

`src/crm/state.ts`, read through `crm_outreach_state` or the `state` field of
`crm_contact_get`. Nothing in it is stored.

| Field | Worked out from |
| --- | --- |
| `lastOutboundAt` | newest `interactions.direction = 'out'`, or newest `outbox.sent_at` where status `sent` — whichever is later |
| `lastInboundAt` | newest `interactions.direction = 'in'` |
| `optedOutAt` | earlier of `suppression.at` and the first `interactions.opt_out = 1` |
| `queuedAt` | oldest unsent `outbox` row, else a `queued` intent |
| `status` | `opted_out` → `replied` (inbound after our last outbound) → `contacted` → `inbound_only` → `new` |
| `blockedBy` | `opted_out` → `do_not_contact` → `already_queued` → `in_conversation` → `cooldown` (a send inside `cooldownDays`, default 30) |

`contactable` is `blockedBy === null`. Two properties matter and both are
tested: a send recorded by the engine blocks the next run **before** the Sent
folder is walked, so a run that dies after sending cannot double-send; and a
contact with no state at all reads `new`, never "blocked forever".

**Why not tags.** `contact_tags` is an unordered set with no timestamp. It
cannot answer "which came last", so a prompt saying "the newest tag wins" was
unanswerable, and a `queued` tag left behind by a crashed run skipped that
person permanently. Tags stayed, demoted to labels: they target a selection,
they never decide eligibility.

## File map and seams (already wired — do not rewire)

```
src/crm/store.ts          CrmStore(db, masterKey)      tables + queries
src/crm/service.ts        CrmService                   mail → contacts/interactions derivation
src/crm/tools.ts          CRM_TOOLS + dispatchCrmTool  MCP surface
src/crm/routes.ts         registerCrmRoutes(app, deps) REST under /api/crm/*
src/automation/store.ts   AutomationStore(db, masterKey)
src/automation/scheduler.ts AutomationScheduler        cron eval + serialized runs
src/automation/tools.ts   AUTOMATION_TOOLS + dispatchAutomationTool
src/automation/routes.ts  registerAutomationRoutes(app, deps)
src/outreach/store.ts     OutreachStore(db, masterKey)
src/outreach/engine.ts    OutreachEngine               follow-ups, opt-out detection, approved-send
src/outreach/tools.ts     OUTREACH_TOOLS + dispatchOutreachTool
src/outreach/routes.ts    registerOutreachRoutes(app, deps)
```

Seams (wired by the architect, present in the skeleton):
- `src/app.ts` constructs the three stores, `CrmService`, `AutomationScheduler`,
  `OutreachEngine`, wires the send guard, starts/stops timers.
- `src/mcp/server.ts` concatenates `CRM_TOOLS`, `AUTOMATION_TOOLS`,
  `OUTREACH_TOOLS` into `tools/list` and routes `tools/call` to the module
  dispatchers via a `PlatformDeps` object.
- `src/api/routes.ts` calls the three `register*Routes` inside `createApi`
  (after auth middleware, so all module routes are token-gated).
- Stores each own their `CREATE TABLE IF NOT EXISTS` DDL, run in constructor.
  Same SQLite handle as `Store` (`store.db`). WAL is already on.

## Schema (DDL owned by each store)

### CrmStore

```sql
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,            -- crypto.randomUUID()
  name TEXT NOT NULL,
  domain TEXT UNIQUE,             -- lowercase, nullable
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,     -- lowercase
  name TEXT,
  title TEXT,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'mail',  -- 'mail' | 'agent' | 'manual'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (contact_id, tag)
);
-- Labels only. Tags are an unordered set with no timestamp, so they cannot
-- express a lifecycle: 'queued' + 'contacted' + 'replied' can all be true at
-- once with nothing to say which came last. Lifecycle lives in the two rows
-- below instead.
CREATE TABLE IF NOT EXISTS contact_intent (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  intent TEXT NOT NULL,                 -- 'queued' | 'do_not_contact'
  at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  note TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  text_enc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,       -- accountId:folder:uid
  direction TEXT NOT NULL,        -- 'in' | 'out'
  at TEXT NOT NULL,               -- message date, ISO
  subject_enc TEXT,
  snippet_enc TEXT,
  UNIQUE (account_id, message_id, contact_id)
);
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL
);
-- Seed once, only when empty: lead, contacted, replied, won, lost (ids = names)
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  stage_id TEXT NOT NULL REFERENCES pipeline_stages(id),
  value REAL,
  currency TEXT,
  position INTEGER NOT NULL DEFAULT 0,  -- order within stage
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Derivation rules (`CrmService.syncFromMail`):
- Walk `messages_list` per account for INBOX and the Sent folder (find via
  `folders_list`; fall back to INBOX-only when no sent folder matches
  /sent/i). Limit 200 per folder per sync.
- For each message, take the counterparty addresses: `from` when inbound,
  `to`+`cc` when outbound. A message is outbound when the from address equals
  the account email (case-insensitive).
- Skip the account's own addresses and no-reply-looking locals
  (/^(no-?reply|notifications?|mailer-daemon|postmaster|bounce)/i).
- Upsert contact by lowercase email; keep the longest non-empty display name
  seen. Insert interaction (ignore on UNIQUE conflict).
- Org auto-link: email domain, unless it is a free provider (gmail.com,
  googlemail.com, outlook.com, hotmail.com, live.com, yahoo.com, icloud.com,
  me.com, proton.me, protonmail.com, gmx.com, gmx.net, web.de, aol.com,
  fastmail.com, hey.com, pm.me, mail.com, msn.com, telenet.be, skynet.be).
  Create the org on first sight (name = domain without TLD, capitalized).
- Sync runs: every 10 minutes in `serve` (timer owned by app.ts skeleton —
  it calls `crmService.syncFromMail()`), and on demand via the
  `crm_sync` MCP tool and `POST /api/crm/sync`.

### AutomationStore

```sql
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cron TEXT NOT NULL,             -- 5-field cron, validated with cron-parser
  prompt TEXT NOT NULL,           -- agent instructions; user-authored, plaintext
  agent_id TEXT,                  -- launcher AgentSpec id; null = first available
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT                -- recomputed on save and after each run
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,           -- 'running' | 'ok' | 'error' | 'killed'
  exit_code INTEGER,
  log_enc TEXT                    -- captured stdout+stderr, truncated to 64 KiB
);
```

Scheduler (`AutomationScheduler`):
- `cron-parser` (add to root package.json dependencies) computes
  `next_run_at`. A 30s interval finds due enabled automations and pushes them
  onto an in-process FIFO. One run executes at a time (invariant 4).
- A run spawns a one-shot headless CLI agent. Extend `AgentLauncher`
  (`src/agent/launcher.ts`) with a `runOnce` path: same binary resolution,
  same MCP wiring, but prompt = the automation's prompt plus a fixed preamble
  (below), no chat loop, capture stdout/stderr into the run row, 15-minute
  hard timeout then SIGKILL and status 'killed'. `runOnce` must not disturb
  the interactive chat agent: when a chat agent is running, queue behind it.
- Run preamble (verbatim, prepended to every automation prompt):
  "You are a scheduled Boxaide automation. Do the task below using the Boxaide
  MCP tools, then exit. You cannot talk to the user: do not call chat tools;
  write nothing to the user. Never send email: queue outreach with
  outbox_queue_draft or save with draft_create and a human will review."
- Pre-approved tools for runs: everything in
  `PREAPPROVED_TOOL_NAMES` (minus the four chat tools) plus all CRM tools,
  all automation *read* tools (`automations_list`, `automation_runs_list`),
  and outreach tools except approval (which has no tool anyway):
  never `message_send`.
- Web access: the CLI's own web tools stay at the CLI's defaults; we do not
  grant or deny them (Claude's headless default allows read-only search).

### OutreachStore

```sql
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,       -- sending account
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'active' | 'paused' | 'done'
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sequence_steps (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,      -- 0 = initial email
  wait_days INTEGER NOT NULL DEFAULT 0,  -- days after previous step, 0 for step 0
  subject_enc TEXT NOT NULL,      -- template; {{name}}, {{email}}, {{org}} substituted
  body_enc TEXT NOT NULL,
  UNIQUE (campaign_id, position)
);
CREATE TABLE IF NOT EXISTS campaign_contacts (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', -- 'active'|'replied'|'opted_out'|'done'|'suppressed'
  current_step INTEGER NOT NULL DEFAULT -1, -- last QUEUED step position
  last_sent_at TEXT,
  next_due_at TEXT,
  PRIMARY KEY (campaign_id, contact_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  campaign_id TEXT,               -- null for one-off agent-queued mail
  contact_id TEXT,
  step_position INTEGER,
  to_addr TEXT NOT NULL,
  subject_enc TEXT NOT NULL,
  body_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'sent'|'rejected'|'failed'
  created_at TEXT NOT NULL,
  decided_at TEXT,
  sent_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS suppression (
  email TEXT PRIMARY KEY,         -- canonicalEmail: trimmed, lowercase, punycoded domain
  reason TEXT NOT NULL,           -- 'reply-stop' | 'manual' | 'bounce' | 'agent'
  at TEXT NOT NULL
);
```

Engine (`OutreachEngine`):
- Hourly tick plus on-demand. For each `active` campaign, for each `active`
  campaign contact where `next_due_at <= now` (or `current_step = -1`):
  - Reply check first: any inbound interaction from that contact after
    `last_sent_at` → state 'replied', stop. Requires CrmStore read access
    (constructor dep).
  - Opt-out check: `src/outreach/opt-out.ts` owns the keyword, the footer
    built from it, the detector (`optOutIntent`) and the canonical address
    form (`canonicalEmail`). No other module defines its own copy.
    - CRM sync runs `optOutIntent` over the full inbound body and records the
      verdict on the interaction row (`interactions.opt_out`). That flag is
      the authority; the engine reads it. A fetch that fails or yields no
      text falls back to the snippet and leaves `opt_out_full = 0`, so the
      next walk retries the body. A stored 0 with `opt_out_full = 1` is a
      finished judgement (full body, or a human who un-suppressed) and is
      not fetched again.
    - The engine's own check runs ONLY when the column itself is absent
      (a process reading a pre-migration database). A stored 0 is a
      judgement — by the sync or by a human who un-suppressed — and is
      never second-guessed from the snippet. It runs per field — subject
      with the subject rule, snippet with the body rule — never over a
      joined string, which would fabricate a phrase across the seam.
    - The rules differ by field. Explicit phrases (unsubscribe, opt out,
      stop emailing/mailing/contacting) count in the sender's own words:
      for a body, the reply portion above quoted thread and the signature
      delimiter — a quoted newsletter's "unsubscribe" footer is not this
      sender opting out. The bare keyword counts at the start of a body,
      and only as the whole subject after reply prefixes are stripped:
      "Re: stop" opts out, "Stop by our booth at SaaStr" does not, and
      "stop" mid-prose ("we should stop by") stays a normal reply.
    - A match → suppress (reason 'reply-stop') + state 'opted_out'.
  - Suppressed email → state 'suppressed', no queue.
  - Otherwise queue the next step into `outbox` (substitute {{name}} — first
    word of contact name or the email local part — {{email}}, {{org}}) with
    status 'pending', advance `current_step`, set
    `next_due_at = now + next step's wait_days`.
  - Every queued step appends the opt-out footer to the body (plain text):
    "\n\n--\nIf you'd rather not hear from me, just reply with \"stop\"."
    Step 0 included. No tracking links, ever.
- Suppression is written at flag time, not by a sweep. The CRM sync fires a
  platform-installed sink (`CrmService.setOptOutSink`, wired in
  `src/platform.ts`) once per freshly flagged inbound message, with the
  address in hand; the sink suppresses ('reply-stop') and moves every
  `campaign_contacts` row for that contact to 'opted_out' (rows already
  'opted_out' or 'suppressed' stay). Scope: only contacts outreach touched —
  a `campaign_contacts` row or an `outbox` row exists. Fresh rows only, so a
  message suppresses exactly once: removing a suppression through
  `DELETE /api/outreach/suppression/:email` also withdraws the stored flags
  (`CrmStore.clearOptOutFlags`), restarts every `opted_out`/`suppressed`
  `campaign_contacts` row for that person at step 0, and nothing re-reads
  old flags — a human removal stands until the contact says stop again.
  `campaign_add_contacts` uses the same restart for an `opted_out` or
  `suppressed` row already in the campaign (`INSERT ... ON CONFLICT DO
  UPDATE`), so re-adding is not a silent no-op. This design (no sweep)
  exists because a sweep over stored flags resurrects removed suppressions,
  and a contact deleted between flag and sweep takes the address with it
  while an approved outbox row lives on.
- Suppression keys are canonical: trimmed, lowercased, and punycoded domain
  (`canonicalEmail`), on write and on lookup. Nodemailer punycodes IDN domains
  before delivery, so "user@münchen.de" and "user@xn--mnchen-3ya.de" must be
  one key.
- Approval → send: `POST /api/outreach/outbox/:id/approve` marks 'approved'
  and the engine sends approved rows in order, spacing sends ≥60s apart with
  ±20s jitter, max `BOXAIDE_SEND_DAILY_CAP` (default 50) engine sends per
  account per UTC day (count outbox rows sent_at that day). Cap reached →
  row stays 'approved' and goes out the next day. Send uses
  `MailService.sendMessage` (guard applies); failure → status 'failed',
  error recorded, no retry in v1. Before each send the engine re-checks the
  suppression list for that recipient: an approved row whose address was
  suppressed after approval becomes 'failed' with 'recipient suppressed:
  <address>', never a row that is silently skipped on every tick.
- The send guard (wired in app.ts): checks to/cc/bcc against `suppression`,
  throws unless override. REST `POST /api/messages/send` accepts
  `overrideSuppression: true`; MCP `message_send` does not.

## MCP tool surface

Naming and description style follows `src/mcp/server.ts` — descriptions tell
the agent when NOT to use a tool. Tools return plain objects; the shared
handler JSON-stringifies. Every module exports `<MODULE>_TOOLS` (schema list,
same shape as `TOOLS`) and `dispatch<Module>Tool(deps, name, args)`.

CRM (`src/crm/tools.ts`):
- `crm_sync` — derive contacts/interactions from mail now; returns counts.
- `crm_contacts_search` { query?, tag?, limit=50 } — search name/email/org.
- `crm_contact_get` { contactId | email } — contact + tags + notes +
  recent interactions (decrypted) + deals + derived `state`.
- `crm_outreach_state` { contactIds? | emails? | query?/tag?, contactableOnly?,
  cooldownDays=30, limit=50 } — per contact: status, `contactable`,
  `blockedBy`, and the timestamps behind them. Derived, never stored; see
  "Contact state" below. Named contacts that do not resolve come back in
  `missing` rather than being dropped.
- `crm_intent_set` { contactId, intent: 'queued' | 'do_not_contact' | 'none',
  note? } — the stored half of contact state. One row per contact; setting
  replaces.
- `crm_contact_upsert` { email, name?, title?, org?, tags?, source='agent' }
- `crm_contact_delete` { contactId }
- `crm_note_add` { contactId, text }
- `crm_org_upsert` { name, domain? }
- `crm_orgs_list` {}
- `crm_interactions_list` { contactId, limit=50 }
- `crm_pipeline_get` {} — stages with deals, board order.
- `crm_deal_upsert` { dealId?, title, contactId?, orgId?, stageId?, value?, currency? }
- `crm_deal_move` { dealId, stageId, position? }
- `crm_deal_delete` { dealId }

Automations (`src/automation/tools.ts`):
- `automation_create` { name, cron, prompt, agentId? } — description must say:
  write the prompt as instructions to a future agent run; validate cron.
- `automation_update` { automationId, name?, cron?, prompt?, agentId?, enabled? }
- `automation_delete` { automationId }
- `automations_list` {}
- `automation_run_now` { automationId } — enqueue immediately.
- `automation_runs_list` { automationId?, limit=20 } — includes decrypted log
  tail (last 4 KiB) per run.

Outreach (`src/outreach/tools.ts`):
- `campaign_create` { name, account, steps: [{subject, body, waitDays}] }
- `campaign_update` { campaignId, name?, status?, steps? } — replacing steps
  only while status 'draft'.
- `campaigns_list` {} — with per-state contact counts.
- `campaign_add_contacts` { campaignId, contactIds } — refuses suppressed.
- `outbox_queue_draft` { account, to, subject, body, contactId?, campaignId? }
  — description: "the ONLY way an automation or agent gets outreach toward
  delivery; a human reviews it in the Boxaide Outreach view before anything
  is sent."
- `outbox_list` { status?, limit=50 } — decrypted subjects/bodies.
- `suppression_add` { email, reason='agent' }
- `suppression_list` {}

Deliberately absent: outbox approve/reject/send tools (invariant 1).

## REST surface (all inside `createApi` after auth)

CRM: GET/POST `/api/crm/contacts`, GET/DELETE `/api/crm/contacts/:id`,
POST `/api/crm/contacts/:id/notes`, GET `/api/crm/contacts/:id/interactions`,
GET/POST `/api/crm/orgs`, GET `/api/crm/pipeline`, POST `/api/crm/deals`,
POST `/api/crm/deals/:id/move`, DELETE `/api/crm/deals/:id`,
POST `/api/crm/sync`.

Automations: GET/POST `/api/automations`, PATCH/DELETE `/api/automations/:id`,
POST `/api/automations/:id/run`, GET `/api/automations/:id/runs`,
GET `/api/automations/runs` (recent across all).

Outreach: GET/POST `/api/outreach/campaigns`, PATCH `/api/outreach/campaigns/:id`,
POST `/api/outreach/campaigns/:id/contacts`, GET `/api/outreach/outbox`
(`?status=`), POST `/api/outreach/outbox/:id/approve`,
POST `/api/outreach/outbox/:id/reject`, GET/POST `/api/outreach/suppression`,
DELETE `/api/outreach/suppression/:email`,
GET `/api/outreach/badge` → `{ pending: n }` (tray + badge poll this).

Updates: GET `/api/update` → the whole `UpdateState`, POST `/api/update/check`,
POST `/api/update/download`, POST `/api/update/install`. Every one of the four
answers with the same state object, so the rail never derives a status of its
own. 409 when the command does not apply — a self-hosted server cannot install,
and an update that is not downloaded cannot be started.

Follow REST conventions in `src/api/routes.ts`: `errorBody` shape, limits
clamped to `MAX_LIMIT`, 404 on unknown ids.

## Web UI (apps/web)

Extend the existing shell (`components/app-shell.tsx`, `rail`), matching its
patterns exactly: client components, hooks in `lib/hooks` calling
`lib/api/endpoints.ts`, view switching via `use-app-state`. New views:
- **People** — contact list (search, tags), detail pane: identity, org, tags,
  notes, interaction timeline, deals. Create/edit contact and note.
- **Pipeline** — kanban board of stages; drag or button-move deals between
  stages; deal create/edit dialog.
- **Automations** — list with enabled toggle, next/last run, run-now button,
  run history with log viewer. Creation happens by talking to the agent —
  the empty state says exactly that and offers to open the Agent view; no
  create form.
- **Outreach** — campaigns list with per-state counts; the **approval queue**:
  pending outbox rows with full preview, Approve / Edit / Reject; suppression
  list management. The rail shows a badge with the pending count
  (poll `/api/outreach/badge` every 30s).

## Desktop (apps/desktop)

Poll `/api/outreach/badge` every 60s from the main process. When `pending`
rises above the last seen value: show a system Notification ("N drafts await
your approval") and set the dock/taskbar badge to the count. Clear the badge
when it returns 0.

## Verification gates (every implementation task runs these before claiming done)

```
npx tsc --noEmit          # from repo root
npx vitest run            # all tests, including the ones you add
```

UI tasks additionally: `cd apps/web && npm run build` and `npx next lint`.
Integration: `npm run build` at root, then `./scripts/start.sh --fixture` and
curl the new endpoints with the fixture token.

## Out of scope for this release

Open/click tracking (conflicts with the privacy posture), multi-pipeline,
sync, per-agent auth scopes, HTML outreach bodies (text only), retries on
failed sends, editing outbox rows via MCP.

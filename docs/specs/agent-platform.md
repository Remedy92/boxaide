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
4. **Bounded concurrent automation runs.** At most `BOXAIDE_AGENT_CONCURRENCY`
   runs are alive at once (default 2, hard cap 4), and never two of the same
   automation — a run still going when its own cron fires makes that one wait,
   while other automations proceed. The interactive chat agent has its own
   slot: it neither waits for runs nor holds them up. Each run works in its own
   directory, removed when it ends.
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
| `firstOutboundAt` | oldest of the same two — the clock a follow-up cadence runs on |
| `outboundCount` | the LARGER of the two counts, never the sum: once the sync walks Sent, an engine send is also an interaction and no id ties them together |
| `lastInboundAt` | newest `interactions.direction = 'in'` |
| `optedOutAt` | earlier of `suppression.at` and the first `interactions.opt_out = 1` |
| `queuedAt` | oldest unsent `outbox` row, else a `queued` intent |
| `status` | `opted_out` → `replied` (inbound after our last outbound) → `contacted` → `inbound_only` → `new` |
| `blockedBy` | `opted_out` → `do_not_contact` → `already_queued` → `in_conversation` (status `replied` OR `inbound_only`: their message is the last word either way) → `cooldown` (a send inside `cooldownDays`, default 30) |

`contactable` is `blockedBy === null`. Three properties matter and all are
tested: a send recorded by the engine blocks the next run **before** the Sent
folder is walked, so a run that dies after sending cannot double-send; a
contact with no state at all reads `new`, never "blocked forever"; and a
question about named contacts never falls back to a page of unrelated ones,
however many of the names fail to resolve.

Blocking governs what automated outreach may **pick**. It is not a send ban —
only suppression is, enforced in the send guard (invariant 2) — so a human or
an agent acting on a specific instruction can still mail a blocked contact.

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
src/automation/scheduler.ts AutomationScheduler        cron eval + concurrent runs
src/automation/tools.ts   AUTOMATION_TOOLS + dispatchAutomationTool
src/automation/routes.ts  registerAutomationRoutes(app, deps)
src/outreach/store.ts     OutreachStore(db, masterKey)
src/outreach/engine.ts    OutreachEngine               follow-ups, opt-out detection, approved-send
src/outreach/tools.ts     OUTREACH_TOOLS + dispatchOutreachTool
src/outreach/routes.ts    registerOutreachRoutes(app, deps)
src/enrichment/service.ts EnrichmentService            provider waterfall, cache, CSV import
src/enrichment/tools.ts   ENRICHMENT_TOOLS + dispatchEnrichmentTool
src/research/service.ts   ResearchService              web search and one-page reads
src/research/tools.ts     RESEARCH_TOOLS + dispatchResearchTool
src/prospecting/service.ts ProspectingService          Apollo people and company search
src/prospecting/tools.ts  PROSPECTING_TOOLS + dispatchProspectingTool
```

Enrichment finds and checks work email addresses through a paid provider
waterfall, Hunter first and Prospeo second, and imports contacts from CSV text.
It owns no table: an answer is held in memory for a day so a repeated lookup is
not billed twice, and nothing it holds is message-derived, so it needs no
master key. It never imports the CRM. Wiring in `src/platform.ts` hands it one
callback that writes a contact, which is the whole of its reach into another
module. Finding an address grants nothing: outreach still owns the queue, the
suppression list, and the human approval step.

Research searches the public web through Exa or Parallel and reads one page at
a time as text. It stores nothing, sends nothing, and has no timers, so both of
its tools are reads by construction and no approval step applies. `web_fetch`
refuses private and loopback addresses, follows at most three redirects with the
same check on every hop, and caps what it returns. The check is the request's
own DNS lookup (`vettingLookup` in `src/research/safe-url.ts`, carried by the
node transport in `src/research/node-fetch.ts`), so the address that passes the
check is the address the socket connects to and a name cannot rebind in
between. No dependency was added for it: node:https already has the hook.

Prospecting answers the question enrichment cannot: who to approach when no
name is known yet. It searches Apollo for people by title, seniority, location
and employer domain, and for companies by keyword, headcount, location and
employee count, and it can open one of those people into a real record. It stores
nothing and owns no table, so it needs no master key and no timers. It reads
its key per call through the same connectors seam as enrichment and research.

Two facts shape its tools rather than being hidden by them. People search is
free but returns an obfuscated last name and no address, so a search result is
a lead and not a contact; opening one is a second, credited call. Company search
costs a credit per page whether or not the page has rows, and Apollo can return
fewer records than the filters imply or suppress EU records entirely, so the
truthful count and those flags are passed back rather than smoothed over.
Prospecting grants nothing either: outreach still owns the queue, the
suppression list, and the human approval step.

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
  model TEXT,                     -- model id that CLI offers; null = its own default
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
  log_enc TEXT                    -- run log, truncated to 64 KiB, tail kept
);
```

Scheduler (`AutomationScheduler`):
- `cron-parser` (add to root package.json dependencies) computes
  `next_run_at`. A 30s interval finds due enabled automations and pushes them
  onto an in-process FIFO. The FIFO dispatches while the launcher has capacity
  and stops when it is full; a finishing run dispatches whatever was waiting,
  so a queue longer than the capacity keeps moving without waiting for the next
  tick (invariant 4).
- Two gates, both required. The FIFO orders work inside one process;
  `AutomationStore.claimRun` holds the cross-process lock, refusing a second
  run of the same automation outright and then refusing anything past the
  concurrency cap. Both counts and the insert are one IMMEDIATE transaction.
- A drain already in progress is not restarted; one more pass is chained onto
  it so work enqueued while it was finishing is not stranded until the next
  tick. One pass, never a loop — a run another process deferred leaves the
  queue non-empty with slots free here, and looping on that would retry the
  claim as fast as SQLite could answer.
- `scheduler.idle()` resolves when nothing is running or queued, and returns
  early when nothing is in flight and no drain is under way: what is left is
  waiting on another process, and no amount of waiting here would free it. `tick()` and
  `runNow()` return once runs are *started*, so anything needing a finished
  result waits on `idle()`.
- A run spawns a one-shot headless CLI agent. `AgentLauncher`
  (`src/agent/launcher.ts`) owns the `runOnce` path: same binary resolution,
  same MCP wiring, but prompt = the automation's prompt plus a fixed preamble
  (below), and no chat loop. `runOnce` takes the run row's id: it keys the live
  run for `killRun(id)` and names the run's own working directory.
- `close()` is final. Every spawn path checks it, including after the model
  lookup in `start()` — shutdown clears the chat slot, so the idle check alone
  would let a launch suspended there spawn an agent nobody owns.
- Runs do not disturb the chat agent and are not disturbed by it. The launcher
  keeps the chat slot and the run slots apart, so Start never fails because the
  schedule is busy, and the schedule never stalls behind a chat session.
- Each run gets `<dataDir>-agents/workdir/runs/<runId>`, removed when the run
  ends and swept at startup past `RUN_WORKDIR_STALE_MS` for the ones a crash
  left behind. Age is the sweep's test, not ownership, because a second process
  over the same data directory may have a run in flight.
- Grok's config home lives inside that per-run directory: its
  `trusted_folders.toml` names the working directory, so a shared home would
  have runs untrusting each other. Claude's `CLAUDE_CONFIG_DIR` stays shared —
  it accumulates state the CLI owns, and an empty home would make every run a
  first run — so every write into it is staged under a temporary name and
  renamed, which is atomic.
- Run log: a spec whose `runArgs` ask for an event stream (`claude` adds
  `--output-format stream-json --verbose`) also carries a `renderRunLine`, and
  the log stores that rendering — session start, assistant text, `[tool]`
  lines, result and errors — plus raw stderr, which stays raw because a crash
  writes plain text there. Specs without a stream store raw captured
  stdout+stderr. Either way the log is truncated to 64 KiB, tail kept: a run
  that failed says why in its last lines.
- Three kill paths, all SIGKILL, each appending a note to the log so a killed
  run is never empty:
  - First-output watchdog (`ONESHOT_FIRST_OUTPUT_TIMEOUT_MS`, 2 min): a streaming run
    that writes no stdout at all in the window never started, so it is ended
    early with status 'error'. First stdout disarms the timer — a healthy
    Claude session prints its start line within seconds, and a gap after that
    is a long tool, not a hang. A wedge after startup waits for the deadline.
    stderr does not feed it, because startup noise is not the agent speaking.
    Non-streaming specs print nothing until the end and get no watchdog.
  - Hard deadline (`ONESHOT_TIMEOUT_MS`, 15 min): status 'killed'.
  - Manual stop (`killRun`, from the UI): status 'killed'.
- Run duration is the honest one: the launcher resolves on stream close, or
  `ONESHOT_CLOSE_GRACE_MS` (2 s) after process exit when a leftover grandchild
  still holds a pipe open. A 15-minute timeout reports about 15 minutes.
- The `claude` CLI runs under an isolated config home — `CLAUDE_CONFIG_DIR`
  set to `<dataDir>-agents/agent-homes/claude` — mirroring grok's isolated
  `GROK_HOME`. `--strict-mcp-config` only covers MCP servers; the isolated
  home is what keeps the user's personal hooks, skills, output styles and
  subagents out of a process Boxaide is responsible for. Credentials are
  copied in per launch and auth-relevant settings keys (`env`, `apiKeyHelper`)
  are carried over; hooks are not. Applies to chat and scheduled runs alike —
  the isolation is about whose config runs, not which path.
- Run preamble (verbatim, prepended to every automation prompt):
  "You are a scheduled Boxaide automation. Do the task below using the Boxaide
  MCP tools, then exit. You cannot talk to the user: do not call chat tools;
  write nothing to the user. Never send email: queue outreach with
  outbox_queue_draft or save with draft_create and a human will review."
  The shared outreach chain (`OUTREACH_CHAIN` in `src/agent/guidance.ts`) is
  appended to it, and to `DRIVEN_SYSTEM` and `KICKOFF`, so every agent gets the
  same five-step order and the same four rules whoever started it.
- Tools for runs: the `run` scope in `src/mcp/scope.ts` — mail reads and
  drafts, all CRM tools, automation *read* tools (`automations_list`,
  `automation_runs_list`), outreach tools, calendar reads, and no chat tool at
  all. `message_send`, `meeting_create` and `meeting_cancel` are in the scope
  and perform nothing: a run may ask, the request is stored, and the user
  approves it in the Agent view when they are next at the window — see
  `src/agent/approvals.ts`. The scope is enforced by the MCP server against the
  token the run carries, not by the CLI's flags; a CLI that offers an allowlist
  flag is additionally given the same list.
- Web access: the CLI's own web tools stay at the CLI's defaults; we do not
  grant or deny them (Claude's headless default allows read-only search).
- File access: a run is confined to its own directory and its CLI's own
  installation and credentials — `workspace` in `src/agent/sandbox.ts`. Nobody
  is watching a scheduled run and the mail it reads was written by strangers,
  so there is no per-run opt-out; `BOXAIDE_AGENT_ACCESS=full` turns it off for
  the install, and a machine with no sandbox runs unconfined and reports it.

### OutreachStore

```sql
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  contact_id TEXT,
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

Campaigns (timed sequences of template steps) shipped and were removed; their
tables (`campaigns`, `sequence_steps`, `campaign_contacts`) are dropped at
migration. The approval queue, the suppression list and the opt-out detection
stand on their own.

Engine (`OutreachEngine`):
- Hourly tick plus on-demand: send every `approved` `outbox` row, oldest
  first, under the per-account daily cap and the minimum send gap.
- Opt-out handling: `src/outreach/opt-out.ts` owns the keyword, the footer
  built from it, the detector (`optOutIntent`) and the canonical address
  form (`canonicalEmail`). No other module defines its own copy.
  - CRM sync runs `optOutIntent` over the full inbound body and records the
    verdict on the interaction row (`interactions.opt_out`). That flag is
    the authority. A fetch that fails or yields no text falls back to the
    snippet and leaves `opt_out_full = 0`, so the next sync retries the
    body. A stored 0 with `opt_out_full = 1` is a finished judgement (full
    body, or a human who un-suppressed) and is not fetched again.
  - The rules differ by field. Explicit phrases (unsubscribe, opt out,
    stop emailing/mailing/contacting) count in the sender's own words:
    for a body, the reply portion above quoted thread and the signature
    delimiter — a quoted newsletter's "unsubscribe" footer is not this
    sender opting out. The bare keyword counts at the start of a body,
    and only as the whole subject after reply prefixes are stripped:
    "Re: stop" opts out, "Stop by our booth at SaaStr" does not, and
    "stop" mid-prose ("we should stop by") stays a normal reply.
  - A match → suppress (reason 'reply-stop').
- Suppression is written at flag time, not by a sweep. The CRM sync fires a
  platform-installed sink (`CrmService.setOptOutSink`, wired in
  `src/platform.ts`) once per freshly flagged inbound message, with the
  address in hand; the sink suppresses ('reply-stop'). Scope: only contacts
  outreach touched — an `outbox` row exists for that contact. Fresh rows
  only, so a message suppresses exactly once: removing a suppression through
  `DELETE /api/outreach/suppression/:email` also withdraws the stored flags
  (`CrmStore.clearOptOutFlags`), and nothing re-reads old flags — a human
  removal stands until the contact says stop again. This design (no sweep)
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
- `automation_create` { name, cron, prompt, agentId?, model? } — description must say:
  write the prompt as instructions to a future agent run; validate cron.
- `automation_update` { automationId, name?, cron?, prompt?, agentId?, model?,
  enabled? } — changing `agentId` alone clears the stored model: a model id
  belongs to one CLI.
- `automation_delete` { automationId }
- `automations_list` {}
- `automation_run_now` { automationId } — enqueue immediately.
- `automation_runs_list` { automationId?, limit=20 } — includes decrypted log
  tail (last 4 KiB) per run.

Outreach (`src/outreach/tools.ts`):
- `outbox_queue_draft` { account, to, subject, body, contactId? }
  — description: "the ONLY way an automation or agent gets outreach toward
  delivery; a human reviews it in the Boxaide Outreach view before anything
  is sent."
- `outbox_list` { status?, limit=50 } — decrypted subjects/bodies.
- `suppression_add` { email, reason='agent' }
- `suppression_list` {}

Deliberately absent: outbox approve/reject/send tools (invariant 1).

Enrichment (`src/enrichment/tools.ts`):
- `enrich_find_email` { orgDomain, fullName? | firstName? + lastName? } — one
  paid lookup; returns address, confidence 0 to 100, status and provider.
- `enrich_verify_email` { email } — same shape, for an address already held.
- `crm_contacts_import` { csv } — header line plus at most 500 rows; every
  skipped row comes back with its line number and reason. Contacts nobody.

Research (`src/research/tools.ts`):
- `web_search` { query, numResults=5, provider? } — ranked results with
  snippets, not page text.
- `web_fetch` { url } — one public http or https page as text.

Prospecting (`src/prospecting/tools.ts`):
- `prospect_find_companies` { keywords?, name?, domains?, locations?,
  excludeLocations?, minEmployees?, maxEmployees?, limit=25 }. One page, so one
  Apollo credit per call whatever comes back. Returns name, `domain`, industry,
  headcount, location, linkedinUrl and `apolloOrgId`.
- `prospect_find_people` { orgDomains?, organizationIds?, titles?, exactTitles?,
  seniorities?, locations?, keywords?, reveal=false, limit=25 }. The free
  search returns a first name, a title and an employer and nothing else, with
  `fullName` null and `revealed` false. `reveal: true` is the credited half and
  is capped at 10 people per call, which also pulls the search page down to 10.

Both refuse an unfiltered search before any HTTP: Apollo answers one with the
whole database, which is a credit spent on nothing. There is no separate reveal
tool, because revealing is a parameter of the search that produced the ids.

A search result is a lead, not a contact. A revealed person with a real address
carries `crmContact`, which is exactly the crm_contact_upsert arguments; one
whose address is locked or absent carries `crmContactPendingEmail` and
`enrichFindEmail` instead, so the address arrives through enrich_find_email and
the contact is a spread rather than four renames done by hand.

Keys come from Settings > Connectors, stored encrypted in the `connectors`
table (`src/connectors/`). The environment stays as the fallback for a headless
install: `BOXAIDE_HUNTER_API_KEY` and `BOXAIDE_PROSPEO_API_KEY` for enrichment,
`BOXAIDE_EXA_API_KEY` and `BOXAIDE_PARALLEL_API_KEY` for research, and
`BOXAIDE_APOLLO_API_KEY` for prospecting. Settings beat
the environment, and nothing is cached, so a key saved in the UI takes effect on
the next call with no restart. With none of a module's keys set, its tools refuse
with a message naming the screen and the variables.

Apollo is its own connector kind, `prospecting`, so it sits under its own
heading in Settings and stays out of the Hunter-then-Prospeo waterfall, which
it is no part of.

`GET /api/connectors` lists all five with a masked key and a source of
`settings`, `env` or null, plus `checks`: the last verdict each provider gave
about the key in force. `PUT /api/connectors/:id` takes `{ apiKey }` and clears
on an empty value. A full key never leaves the server.

`POST /api/connectors/:id/check` asks the provider whether the key in force
works, whether that key came from settings or from the environment, and stores
the answer (`src/connectors/probe.ts`, `probes.ts`, and one probe per adapter).
The verdict is `works`, `rejected` with the provider's own reason, or
`unreachable` for a timeout, a network failure, a 429 or a 5xx, which are never
reported as a bad key. The probe deadline is five seconds, because somebody is
watching the row it fills in. Each probe is the cheapest authenticated call that
provider offers: Apollo's free people search at one row per page, Hunter's
`/v2/account`, Prospeo's `/account-information`, and, because neither has a free
way to test a key, a one-result search at Exa and at Parallel, which the
Connectors screen says out loud before it spends anything. Saving a key runs the
check by itself, so the operator still presses Enter once, and saving a new key
drops the old verdict rather than letting it stand.

With no search connector at all, a launched CLI keeps its own web search and
fetch instead (`LaunchContext.searchConfigured` in `src/agent/launcher.ts`).
Configure Exa or Parallel and the launcher goes back to stripping those tools,
so agents search through Boxaide.

Scope (`src/mcp/scope.ts`): `web_search`, `web_fetch`, `enrich_find_email` and
`enrich_verify_email` are in all three profiles. `crm_contacts_import` is not in
`run`, which has no person to hand it a file. `prospect_find_companies` and
`prospect_find_people` are in all three profiles, a scheduled run included: a
run told to watch a market cannot do it without asking who is in that market.
Scope is by tool name and revealing is a parameter, so what bounds the spend is
the per-call cap, not the profile.

Pre-send verification: when an enrichment provider is configured, the outreach
engine verifies each approved recipient immediately before the send. A verdict
of `invalid` fails the row with the address in the error and it leaves the
queue; `risky`, `unknown` and a verifier that is down do not block anything.
The day-long cache means a row held back by the daily cap is not billed twice.

## Workspace memory

The agent keeps its own notes as plaintext markdown in
`<dataDir>-agents/workdir/memory/` (`src/memory/store.ts`; the layout rule that
keeps them out of the data directory is `src/agent/paths.ts`) — `MEMORY.md` as
the index plus the topic files it names. Agents read and write them with their
native file tools; the REST routes under `/api/memory` exist for a human
editing the same files.

Every launch is told what exists there (`src/agent/memory-context.ts`). Driven
turns and automation runs read it fresh each time: a session outlives the notes
it opened with, and an agent handed a block frozen at launch keeps offering to
build notes it has already written. A KICKOFF launch is sent one prompt by
nature, so its block is the one true at launch.

- **Chat and driven sessions, no `MEMORY.md` yet** — one ask-first block: the
  agent may offer, once, to skim mailbox, CRM and calendar (~15 tool calls)
  and only after the user agrees write the index plus `company.md`,
  `voice.md`, `people.md`. Every fact names its source; no passwords or keys.
- **Chat and driven sessions, notes exist** — the index, capped at ~2000
  characters with the tail marked, plus the duty to keep the files current
  itself.
- **Automation runs** — never the ask (nobody is there to consent) and never
  the update duty (a run's directory is not the workdir): the capped index
  with `company.md` and `voice.md` inlined, each capped at ~1500 characters,
  inserted between the run preamble and the task. No notes stored, nothing
  injected.

A read that fails degrades to the no-notes or empty case; a launch never
fails over its notes.

Names are narrow — `[a-z0-9][a-z0-9-]*.md`, because the name in a route path is
joined onto a filesystem path — plus `MEMORY.md` itself, which the listing puts
first and a person opens first. Listing and reading answer that same question,
so no row is offered that the reader would refuse.

## REST surface (all inside `createApi` after auth)

CRM: GET/POST `/api/crm/contacts`, GET/DELETE `/api/crm/contacts/:id`,
POST `/api/crm/contacts/:id/notes`, GET `/api/crm/contacts/:id/interactions`,
GET/POST `/api/crm/orgs`, GET `/api/crm/pipeline`, POST `/api/crm/deals`,
POST `/api/crm/deals/:id/move`, DELETE `/api/crm/deals/:id`,
POST `/api/crm/sync`.

Automations: GET/POST `/api/automations`, PATCH/DELETE `/api/automations/:id`,
POST `/api/automations/:id/run`, GET `/api/automations/:id/runs`,
GET `/api/automations/runs` (recent across all).

Outreach: GET `/api/outreach/outbox`
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
- **Outreach** — the **approval queue**:
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

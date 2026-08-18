# Parallel agent runs — what blocks them and what it costs to allow them

**Date:** 2026-08-17
**Status:** implemented — see `src/agent/launcher.ts`, `src/automation/scheduler.ts`, `src/automation/store.ts`, and invariant 4 in `docs/specs/agent-platform.md`.
**Scope:** `src/agent/launcher.ts`, `src/automation/scheduler.ts`, `src/automation/store.ts`, `docs/specs/agent-platform.md` invariant 4.

## The rule today

One agent process at a time, chat or automation. It is a written invariant, not
an accident:

> **4. One automation agent at a time.** Automation runs are serialized in a
> queue. A run that is still going when the next fires makes the next wait.
> — `docs/specs/agent-platform.md:26`

Three separate gates enforce it. All three must change together; loosening any
one alone either does nothing or breaks the others.

| Gate | Where | What it blocks | Cross-process? |
|---|---|---|---|
| Launcher slot | `launcher.ts:1186` `assertIdle`, `:1204` `busy()`, `:1353` `runOnce` | Any second spawn in this process. Chat and automation share the slot. | no |
| Scheduler FIFO | `scheduler.ts:109` `drainLoop` | Awaits each run before dequeuing the next; returns outright while a chat agent holds the slot. | no |
| DB run claim | `store.ts:368` `claimRun` | `COUNT(*) WHERE status='running' > 0` → refuse. Taken in an IMMEDIATE transaction. | yes — this is the only gate a second `boxaide mcp` process respects |

The launcher also keeps two distinct fields, `running` (chat) and `oneShot`
(automation), each holding at most one child, plus a single `killOneShot`
closure. Any concurrency design has to turn those into collections.

## What is already safe for concurrency

Worth stating, because it shrinks the job considerably.

- **The MCP server is stateless.** `/mcp` is a plain JSON-RPC POST handler with
  no session state (`app.ts:216`, and the DELETE handler says so at `:273`).
  Ten concurrent agents can call tools against it today.
- **Automations cannot send email.** The run preamble forbids it and the
  allowlist omits `message_send` (`launcher.ts:157`). Sends go through the
  server-side engine with its own daily cap and 60s gap (spec invariant 5). So
  parallel runs cannot double-send. This is the single biggest reason the
  change is tractable.
- **SQLite is WAL with synchronous writes.** `journal_mode = WAL`
  (`db/store.ts:159`), and better-sqlite3 is synchronous, so writes from one
  process serialize on their own. Cross-process writes are covered by WAL plus
  the IMMEDIATE transactions already used for claims and sweeps.
- **The stale-run sweep is already count-based**, not identity-based
  (`store.ts:405`), so it keeps working with several live rows.

## What actually breaks under concurrency

Five things, in descending order of how much they matter.

### 1. Two runs of the *same* automation can overlap

Today the global lock hides this. The scheduler dedupes an id against
`active` and the queue (`scheduler.ts:92`), but that is in-process only. A
second process, or a `run_now` racing a cron tick, could start the same
automation twice. Two copies of the same prompt doing the same work is the
worst failure mode here — duplicate drafts, duplicate CRM notes.

**Fix:** the per-automation lock must be *stricter* than the capacity lock, and
must live in the DB, not in the scheduler. `claimRun` becomes: refuse if this
automation already has a live run; otherwise refuse if total live runs ≥ N.

### 2. Duplicate queued drafts across *different* automations

`outbox_queue_draft` → `queueOutbox` has no dedupe key (`outreach/tools.ts:244`,
`outreach/store.ts`). Two automations that both decide to reach the same contact
queue two drafts. Today the serial lock does not prevent this either — it only
makes it less likely by spreading runs out in time.

**Severity: low.** The outbox is human-approved before anything sends. The cost
is review noise, not a bad send. But concurrency makes it common instead of
rare, so it wants a fix in the same change.

**Fix:** a uniqueness constraint on pending outbox rows per (account, contact,
campaign), or a soft check in `queueOutbox` that returns the existing row.

### 3. Shared working directory

Every run uses one directory, `<dataDir>/agent-workdir` (`launcher.ts:773`), as
its cwd. `claudePrepare` writes `claude-mcp.json` into it on every launch;
`grokPrepare` writes `.grok/config.toml` and `trusted_folders.toml`
(`launcher.ts:496`, `:665`).

The config writes are idempotent — same content every time — so concurrent
prepares race harmlessly. The real problem is that agents *work* in that
directory. Two runs writing scratch files with the same name will clobber each
other, and neither will know.

**Fix:** per-run workdir, `<dataDir>/agent-workdir/<runId>`, created at spawn
and removed at finish. The chat agent keeps a stable one so its session
survives across turns.

### 4. Shared CLI config home and credential refresh

`CLAUDE_CONFIG_DIR` points at one shared `agent-homes/claude`
(`launcher.ts:484`), and both prepares copy or symlink credentials in on every
launch via `refreshLink`, which unlinks then relinks (`launcher.ts:744`).

Two prepares overlapping can leave a window where `auth.json` does not exist,
and a CLI starting in that window fails to authenticate. It is a narrow window
and today it can never be hit. Under concurrency it can.

**Fix:** write to a temp name and rename over the target (rename is atomic), or
serialize `prepare` behind a small in-process lock. The config *home* itself can
stay shared — both CLIs handle concurrent sessions against one config dir; it is
only the refresh that is unsafe.

### 5. Resource and cost ceiling

Each run is a full CLI process with a model session behind it. N parallel runs
is N times the token spend in the same window, N times the memory, and N times
the pressure on whatever per-account rate limit the CLI's provider applies. A
provider 429 surfaces as a failed run with an opaque log.

**Fix:** make N a config value with a low default, and cap it. Do not make it
unbounded.

## Proposed design

Chat agent stays privileged and single. The Agent pane is one pane, driving one
conversation; nothing asks for two. What changes is that **automation runs stop
sharing the chat agent's slot** and gain a capacity of N among themselves.

### Concurrency model

- `BOXAIDE_AGENT_CONCURRENCY`, default **2**, hard cap **4**.
- Default 2, not 1, so the feature is on and observable. Not higher, because of
  §5 and because nothing yet tells us the failure modes at 4.
- One chat agent, always. Unchanged.
- At most one live run **per automation**, at any N. Non-negotiable — see §1.
- A chat agent does **not** block automation runs any more. It gets its own
  slot. This alone removes the most common complaint: a long chat session
  currently starves every scheduled run behind it (`scheduler.ts:114`).

### Changes by file

**`src/agent/launcher.ts`**
- `oneShot: ChildProcess | null` → `oneShots: Map<runId, { child, kill }>`.
- `killOneShot` closure → per-entry, keyed by run id.
- `runOnce(opts)` takes a `runId`, refuses when `oneShots.size >= N`, spawns
  into its own workdir, and deletes its entry in `finish()`.
- `killRun()` → `killRun(runId?)`; no argument kills all, which is what
  `scheduler.stop()` and app shutdown want (`scheduler.ts:68`, `launcher.ts:1527`).
- `busy()` splits into `chatBusy()` and `runCapacity()`. `assertIdle` keeps
  guarding the chat slot only, and keeps the re-check after every await
  (`launcher.ts:1239` — that comment stays true and still matters).
- `prepareWorkDir` takes a run id; `agentWorkDir` gains a per-run variant.

**`src/automation/store.ts`**
- `claimRun(automationId, { limit })`: inside the existing IMMEDIATE
  transaction, first refuse if a live run exists for *this* automation, then
  refuse if the live count is ≥ limit. Keep `sweepStaleRunsAt` first — a stale
  row must not consume a slot.
- Index on `automation_runs(status, automation_id)` — the claim now runs two
  reads per attempt, several times a minute.

**`src/automation/scheduler.ts`**
- `active: string | null` → `active: Set<string>`; `state()` returns an array.
  Check the UI consumers of `state()` before changing the shape.
- `drainLoop` dispatches while capacity remains instead of awaiting each run,
  and tracks in-flight promises so `stop()` can await or kill them.
- Drop the `if (this.launcher.busy()) return` early exit — with a separate chat
  slot it is no longer a reason to stall the queue.
- `deferred` handling stays exactly as it is. The DB claim remains the final
  authority across processes, and putting the job back at the head of the queue
  is still the right response.

**`src/outreach/store.ts`** — dedupe pending outbox rows (§2).

**`docs/specs/agent-platform.md`** — invariant 4 is rewritten, not deleted. It
becomes: at most N concurrent automation runs, at most one per automation, chat
agent separate. Every comment in the three files that cites "invariant 4" or
"the single run slot" needs the same pass.

### Phasing

Each phase is shippable and testable on its own.

1. **Split the chat slot from the automation slot.** Concurrency stays 1 for
   automations. Effect: a chat session no longer starves the schedule. Smallest
   change, largest immediate benefit, no new race surface.
2. **Per-run workdir and atomic credential refresh** (§3, §4). Still serial, so
   nothing can break yet — this is groundwork under a lock that still holds.
3. **Per-automation lock in `claimRun`** (§1). Still serial. Verifiable by
   test: two claims for the same id, second refused.
4. **Raise N.** Launcher map, scheduler dispatch loop, config value. This is the
   phase where concurrency actually turns on, and by now everything it could
   break has already been fixed.
5. **Outbox dedupe** (§2). Independent of the rest; can land any time.

## Open questions — need your decision

1. **Default N.** 2 is my recommendation. Higher trades cost and rate-limit risk
   for throughput on a workload that is currently unmeasured.
2. **Should the chat agent be exempt from the cap entirely, or count toward it?**
   I say exempt. It is user-driven and interactive; a scheduled job should never
   make the app feel broken.
3. **What does the UI show while three runs are live?** The Automations view
   assumes one active id today. Needs a design pass before phase 4 lands.
4. **Is per-automation-single actually right?** A user could reasonably want a
   fast-cadence automation to overlap itself. I say no for now — the duplicate
   work risk is real and the demand is hypothetical.

## What this research did not cover

- No measurement of real run durations or token spend. The cost argument in §5
  is structural, not empirical.
- The Electron/desktop side was not examined for assumptions about a single
  running agent.
- No test-suite audit. The scheduler tests inject a fake launcher
  (`scheduler.ts:19`), so they will need the new shape, but I did not read them.

## As built — where the implementation differs from the plan above

Decisions 1, 2 and 4 were taken as recommended: N defaults to 2 with a cap of 4,
the chat agent is exempt, and an automation never overlaps itself. Three details
changed while building it.

**Question 3 answered itself.** The Automations view never reads
`scheduler.state()` — it derives status from the run rows, one card per
automation (`use-automations.ts`, `run-history.tsx`). Several live runs render
correctly with no change. No design pass was needed.

**Grok's config home moved into the per-run directory** rather than staying
shared. §4 above proposed atomic writes into a shared home for both CLIs, but
Grok's `trusted_folders.toml` names the working directory it trusts, so a second
run writing its own path would untrust the directory the first run is standing
in. Nothing in that home survives a launch — `grokPrepare` rewrites all of it
every time — so making it per-run costs nothing. Claude's home stays shared,
because it accumulates state the CLI owns and an empty one would make every run
a first run; its writes are staged and renamed instead.

**The outbox dedupe is narrower than §2 proposed.** A key of (account, contact,
campaign) would also swallow a second, genuinely different draft. A draft that
silently never appears is worse than two similar ones: a reviewer can delete a
duplicate they can see and cannot recover one they never got. So the match is
the whole message — recipient, campaign, step, subject and body — which makes a
repeated queue idempotent without ever dropping distinct work. Two overlapping
runs that write differently-worded mail to the same person still produce two
pending rows for a human to sort out.

**Also added, not in the plan:** `scheduler.idle()`. `tick()` and `runNow()`
now return once runs are started rather than finished, so anything that needs a
finished result — the end-to-end tests, a shutdown that waits — has to have
something to wait on.

### Still not covered

- No measurement of real concurrent runs against live CLIs. Everything here is
  proved by the test suite with fake binaries and a scripted agent; the cost and
  rate-limit argument in §5 remains structural, not empirical.
- The Electron/desktop side was still not examined.

## Review follow-up

A review of the commit above raised six points. Four were taken, with one
changed on the way in.

- **`idle()` could spin.** A run deferred by another process leaves this
  scheduler with an empty in-flight set, free local slots, and a non-empty
  queue — the capacity guard did not catch that and the loop burned CPU. The
  guard now asks whether anything is actually under way.
- **`close()` was not final.** Shutdown clears the chat slot, so a `start()`
  suspended on the model lookup would resume, find the slot free, and spawn an
  agent moments after everything else was killed. A `closed` flag now gates
  every spawn path. This predated concurrency; it was not introduced here.
- **A run killed twice wrote its note twice.** The kill closure now returns if
  the run is already ending — the first reason is the true one.
- **`queueOutbox` was not atomic.** Taken, but not for the reason given: two
  runs inside one process cannot interleave there, because the code never
  yields between the look-up and the insert. The real exposure is a second
  `boxaide mcp` process serving the same tool over the same file. Now one
  IMMEDIATE transaction.

Two were declined.

- **The proposed `drain()` rewrite loops while the queue is non-empty and
  capacity is free.** That is exactly the state a deferred run leaves behind,
  so it would retry the claim — a write-lock transaction — as fast as SQLite
  could answer, indefinitely. The underlying window is real but narrow: work
  enqueued in the moment a drain is finishing waits for the next tick. Fixed
  instead by chaining one more pass onto the drain in progress. One pass
  terminates; a loop on that condition does not.
- **A `stopped` flag on the scheduler.** The claimed failure — a spawn after
  `killRun()` — has no path: `stop()` empties the queue, and the dispatch loop
  re-reads it every iteration, with no suspension between claiming a slot and
  spawning. The suggested patch also left a stopped scheduler permanently
  unable to restart.

Tests added for the two genuine gaps (the outbox merge, the startup sweep) and
for the shutdown fix. Each was checked against a deliberately broken build to
confirm it fails when the code it covers is removed.

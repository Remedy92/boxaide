/**
 * Automation tables and queries. DDL: docs/specs/agent-platform.md.
 * Owns: automations, automation_runs. Run logs are encrypted (log_enc) —
 * agent output quotes mail content.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";

export type RunStatus = "running" | "ok" | "error" | "killed";

export type Automation = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  /** AgentSpec id from the launcher registry; null = first available. */
  agentId: string | null;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  exitCode: number | null;
  /** Decrypted, last LOG_TAIL_LIMIT bytes only. Empty when nothing was captured. */
  log: string;
};

type AutomationRow = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  agent_id: string | null;
  enabled: number;
  created_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
};

type RunRow = {
  id: string;
  automation_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  exit_code: number | null;
  log_enc: string | null;
};

/** Whole captured output kept in the row; readers get the tail (see LOG_TAIL_LIMIT). */
export const LOG_LIMIT = 64 * 1024;

/** What a reader (MCP tool, REST, UI) gets back per run. */
export const LOG_TAIL_LIMIT = 4 * 1024;

/**
 * Mirrors ONESHOT_TIMEOUT_MS in src/agent/launcher.ts. It is duplicated, not
 * imported: launcher.ts imports automation/tools.ts, which imports this file,
 * so importing the launcher here would close an import cycle.
 */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A 'running' row older than this belongs to a process that died: the launcher
 * hard-kills its own child at RUN_TIMEOUT_MS, and the grace covers the SIGKILL
 * plus the finishRun write. Younger rows are never swept — another live
 * process may own them.
 */
export const RUN_STALE_MS = RUN_TIMEOUT_MS + 5 * 60 * 1000;

/** Appended to a run log when the sweep finalizes a row nobody finished. */
export const STALE_RUN_NOTE =
  "[boxaide] marked killed: the process running this automation exited without finishing the run.";

/**
 * A cron field count of 5 is the contract (spec DDL), and it is enforced here
 * rather than left to cron-parser: the parser also accepts a 6-field form
 * whose first field is seconds, so "* * * * * *" would silently become an
 * every-second automation spawning agent processes.
 */
export function nextRunAfter(cron: string, from: Date = new Date()): Date {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `invalid cron expression "${cron}": expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  try {
    return CronExpressionParser.parse(cron, { currentDate: from })
      .next()
      .toDate();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid cron expression "${cron}": ${detail}`);
  }
}

export class AutomationStore {
  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        agent_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT
      );
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        log_enc TEXT
      );
      CREATE INDEX IF NOT EXISTS automation_runs_by_automation
        ON automation_runs (automation_id, started_at DESC);
    `);
  }

  create(input: {
    name: string;
    cron: string;
    prompt: string;
    agentId?: string | null;
    enabled?: boolean;
    now?: Date;
  }): Automation {
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    if (!input.prompt.trim()) throw new Error("prompt is required");
    const now = input.now ?? new Date();
    // Validate before the INSERT: a stored automation with an unparseable cron
    // would be a row the scheduler can never schedule and never explain.
    const next = nextRunAfter(input.cron, now);
    const row: AutomationRow = {
      id: randomUUID(),
      name,
      cron: input.cron.trim(),
      prompt: input.prompt,
      agent_id: input.agentId ?? null,
      enabled: input.enabled === false ? 0 : 1,
      created_at: now.toISOString(),
      last_run_at: null,
      next_run_at: next.toISOString(),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO automations
             (id, name, cron, prompt, agent_id, enabled, created_at, last_run_at, next_run_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.name,
          row.cron,
          row.prompt,
          row.agent_id,
          row.enabled,
          row.created_at,
          row.last_run_at,
          row.next_run_at,
        );
    } catch (err) {
      // UNIQUE(name) is the only constraint a caller can trip; say so plainly
      // instead of leaking SQLITE_CONSTRAINT to an agent or the UI.
      if (String(err).includes("UNIQUE")) {
        throw new Error(`an automation named "${name}" already exists`);
      }
      throw err;
    }
    return toAutomation(row);
  }

  update(
    id: string,
    patch: {
      name?: string;
      cron?: string;
      prompt?: string;
      agentId?: string | null;
      enabled?: boolean;
      now?: Date;
    },
  ): Automation | null {
    const current = this.get(id);
    if (!current) return null;
    const now = patch.now ?? new Date();
    const next: Automation = {
      ...current,
      name: patch.name?.trim() || current.name,
      cron: patch.cron?.trim() || current.cron,
      // Empty keeps the current value, like name and cron above: create
      // rejects an empty prompt, so update must not produce one either — a
      // run with no prompt would spawn an agent carrying only the preamble.
      prompt: patch.prompt?.trim() ? patch.prompt : current.prompt,
      agentId: patch.agentId !== undefined ? patch.agentId : current.agentId,
      enabled: patch.enabled ?? current.enabled,
    };
    // Recompute on every save, not only on a cron change: re-enabling a
    // long-disabled automation must not fire on a next_run_at from last month.
    next.nextRunAt = next.enabled
      ? nextRunAfter(next.cron, now).toISOString()
      : null;
    try {
      this.db
        .prepare(
          `UPDATE automations
              SET name = ?, cron = ?, prompt = ?, agent_id = ?, enabled = ?, next_run_at = ?
            WHERE id = ?`,
        )
        .run(
          next.name,
          next.cron,
          next.prompt,
          next.agentId,
          next.enabled ? 1 : 0,
          next.nextRunAt,
          id,
        );
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        throw new Error(`an automation named "${next.name}" already exists`);
      }
      throw err;
    }
    return next;
  }

  delete(id: string): boolean {
    // Runs are ON DELETE CASCADE in the DDL, but foreign keys are off by
    // default in SQLite and this store does not own the pragma, so the child
    // rows go explicitly.
    this.db.prepare(`DELETE FROM automation_runs WHERE automation_id = ?`).run(id);
    return (
      this.db.prepare(`DELETE FROM automations WHERE id = ?`).run(id).changes > 0
    );
  }

  get(id: string): Automation | null {
    const row = this.db
      .prepare(`SELECT * FROM automations WHERE id = ?`)
      .get(id) as AutomationRow | undefined;
    return row ? toAutomation(row) : null;
  }

  list(): Automation[] {
    const rows = this.db
      .prepare(`SELECT * FROM automations ORDER BY name ASC`)
      .all() as AutomationRow[];
    return rows.map(toAutomation);
  }

  /** Enabled automations whose next_run_at has arrived. */
  due(now: Date = new Date()): Automation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM automations
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC`,
      )
      .all(now.toISOString()) as AutomationRow[];
    return rows.map(toAutomation);
  }

  /** Records the run boundary: what fired, and when it may fire again. */
  noteRun(id: string, at: Date, nextRunAt: string | null): void {
    this.db
      .prepare(
        `UPDATE automations SET last_run_at = ?, next_run_at = ? WHERE id = ?`,
      )
      .run(at.toISOString(), nextRunAt, id);
  }

  startRun(automationId: string, at: Date = new Date()): AutomationRun {
    const run: AutomationRun = {
      id: randomUUID(),
      automationId,
      startedAt: at.toISOString(),
      finishedAt: null,
      status: "running",
      exitCode: null,
      log: "",
    };
    this.db
      .prepare(
        `INSERT INTO automation_runs
           (id, automation_id, started_at, finished_at, status, exit_code, log_enc)
         VALUES (?, ?, ?, NULL, 'running', NULL, NULL)`,
      )
      .run(run.id, run.automationId, run.startedAt);
    return run;
  }

  /**
   * Takes the cross-process run lock and opens the run row, or returns null.
   *
   * The in-process FIFO only serializes runs inside one process, but a stdio
   * `boxaide mcp` process has its own scheduler over the same SQLite file
   * (automation_run_now), so two processes could overlap runs and break spec
   * invariant 4. The 'running' row is therefore the lock: sweep dead rows,
   * count live ones and insert, all in ONE transaction. Callers that get null
   * must keep the job queued and retry — the lock holder is still working.
   */
  claimRun(
    automationId: string,
    opts: { now?: Date; staleMs?: number } = {},
  ): AutomationRun | null {
    const now = opts.now ?? new Date();
    const staleMs = opts.staleMs ?? RUN_STALE_MS;
    // .immediate(): a deferred transaction begins read-only and only takes the
    // write lock at the INSERT — precisely the window where the other process
    // could read "nothing running" and insert as well. IMMEDIATE takes the
    // write lock up front, so the count and the insert are one atomic step
    // against every other connection to this file.
    return this.db.transaction((): AutomationRun | null => {
      this.sweepStaleRunsAt(now, staleMs);
      const live = this.db
        .prepare(`SELECT COUNT(*) AS n FROM automation_runs WHERE status = 'running'`)
        .get() as { n: number };
      // Only fresh rows are left after the sweep, so any survivor is a run
      // someone is really executing right now.
      if (live.n > 0) return null;
      return this.startRun(automationId, now);
    }).immediate();
  }

  /**
   * Finalizes 'running' rows nobody will ever finish (a quit or crash mid-run
   * leaves them 'running' forever). Runs inside claimRun, and once when a
   * scheduler constructs, so whichever process touches automations next cleans
   * up after the one that died. Returns how many rows it closed.
   */
  sweepStaleRuns(opts: { now?: Date; staleMs?: number } = {}): number {
    const now = opts.now ?? new Date();
    const staleMs = opts.staleMs ?? RUN_STALE_MS;
    return this.db
      .transaction(() => this.sweepStaleRunsAt(now, staleMs))
      .immediate();
  }

  private sweepStaleRunsAt(now: Date, staleMs: number): number {
    const cutoff = new Date(now.getTime() - staleMs).toISOString();
    const stale = this.db
      .prepare(
        `SELECT id, log_enc FROM automation_runs
          WHERE status = 'running' AND started_at <= ?`,
      )
      .all(cutoff) as { id: string; log_enc: string | null }[];
    for (const row of stale) {
      // Keep whatever output the dead process managed to persist and say why
      // the row closed, so a user reading the run does not see a bare 'killed'.
      const previous = row.log_enc ? decryptSecret(this.masterKey, row.log_enc) : "";
      const log = (previous ? `${previous}\n${STALE_RUN_NOTE}` : STALE_RUN_NOTE).slice(
        -LOG_LIMIT,
      );
      this.db
        .prepare(
          `UPDATE automation_runs
              SET finished_at = ?, status = 'killed', log_enc = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(now.toISOString(), encryptSecret(this.masterKey, log), row.id);
    }
    return stale.length;
  }

  finishRun(
    runId: string,
    result: { status: RunStatus; exitCode: number | null; log?: string; at?: Date },
  ): void {
    const log = (result.log ?? "").slice(-LOG_LIMIT);
    this.db
      .prepare(
        `UPDATE automation_runs
            SET finished_at = ?, status = ?, exit_code = ?, log_enc = ?
          WHERE id = ?`,
      )
      .run(
        (result.at ?? new Date()).toISOString(),
        result.status,
        result.exitCode,
        log ? encryptSecret(this.masterKey, log) : null,
        runId,
      );
  }

  listRuns(opts: { automationId?: string; limit?: number } = {}): AutomationRun[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const rows = (
      opts.automationId
        ? this.db
            .prepare(
              `SELECT * FROM automation_runs WHERE automation_id = ?
                ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(opts.automationId, limit)
        : this.db
            .prepare(
              `SELECT * FROM automation_runs ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(limit)
    ) as RunRow[];
    return rows.map((row) => this.toRun(row));
  }

  private toRun(row: RunRow): AutomationRun {
    return {
      id: row.id,
      automationId: row.automation_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status as RunStatus,
      exitCode: row.exit_code,
      log: row.log_enc
        ? decryptSecret(this.masterKey, row.log_enc).slice(-LOG_TAIL_LIMIT)
        : "",
    };
  }
}

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    agentId: row.agent_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

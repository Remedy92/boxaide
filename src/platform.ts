/**
 * The agent platform: CRM, automations, outreach.
 *
 * One factory so every entry point (serve, stdio mcp, tests) constructs the
 * same object graph. Timers are explicit: `start()` runs the schedulers and
 * is called ONLY by the serve process — a stdio `boxaide mcp` process shares
 * the SQLite file and must never run a second scheduler against it.
 *
 * Spec: docs/specs/agent-platform.md. Module code lives in src/crm,
 * src/automation, src/outreach; this file only wires.
 */
import type Database from "better-sqlite3";
import type { MailService } from "./mail/service.js";
import type { Store } from "./db/store.js";
import { ArchiveLog } from "./agent/archive-log.js";
import type { AgentLauncher } from "./agent/launcher.js";
import { CrmStore } from "./crm/store.js";
import { CrmService } from "./crm/service.js";
import { AutomationStore } from "./automation/store.js";
import { AutomationScheduler } from "./automation/scheduler.js";
import { OutreachStore } from "./outreach/store.js";
import { OutreachEngine } from "./outreach/engine.js";
import { CalendarStore } from "./calendar/store.js";
import { CalendarService } from "./calendar/service.js";

/**
 * Shape of one MCP tool definition, structurally identical to the entries of
 * TOOLS in src/mcp/server.ts so module tool lists concatenate into tools/list.
 */
export type ToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
};

export type Platform = {
  crmStore: CrmStore;
  crmService: CrmService;
  automationStore: AutomationStore;
  scheduler: AutomationScheduler;
  outreachStore: OutreachStore;
  engine: OutreachEngine;
  calendarStore: CalendarStore;
  /** Agenda, free slots, and the meeting write path. No timers of its own. */
  calendarService: CalendarService;
  /**
   * What launched agents archived, and the sweep-sized undo for it. Null on a
   * platform built without a Store — the stdio and test graphs that only need
   * the tool modules.
   */
  archiveLog: ArchiveLog | null;
  /** Start CRM sync, automation scheduler, and outreach engine timers. */
  start: () => void;
  /** Stop every timer and any in-flight automation run. */
  stop: () => void;
};

export function createPlatform(opts: {
  db: Database.Database;
  masterKey: Buffer;
  mail: MailService;
  launcher: AgentLauncher;
  /**
   * Needed only by the archive log, which writes its own table. Optional so
   * the graphs that build a platform from a bare database keep working.
   */
  store?: Store;
  /** Path to the macOS calendar helper, when the shell knows one. */
  calendarHelperPath?: string;
}): Platform {
  const archiveLog = opts.store ? new ArchiveLog(opts.store, opts.mail) : null;
  const crmStore = new CrmStore(opts.db, opts.masterKey);
  const crmService = new CrmService(crmStore, opts.mail);
  const automationStore = new AutomationStore(opts.db, opts.masterKey);
  const scheduler = new AutomationScheduler(automationStore, opts.launcher);
  const outreachStore = new OutreachStore(opts.db, opts.masterKey);
  const engine = new OutreachEngine(outreachStore, crmStore, opts.mail);
  // Calendar is read-on-demand: no scheduler, no sync loop. It sends invites
  // through the same MailService, so the suppression guard below covers it.
  const calendarStore = new CalendarStore(opts.db, opts.masterKey);
  const calendarService = new CalendarService(
    calendarStore,
    opts.mail,
    undefined,
    opts.calendarHelperPath,
  );

  // Suppression is enforced at the send chokepoint for every caller (spec
  // invariant 2). The guard lives here, not in MailService, so mail stays
  // ignorant of outreach.
  opts.mail.setSendGuard((recipients, override) => {
    if (override) return;
    for (const addr of recipients) {
      if (outreachStore.isSuppressed(addr)) {
        throw new Error(`recipient suppressed: ${addr}`);
      }
    }
  });

  // Opt-outs suppress at flag time: the CRM sync sees the "stop" with the
  // address in hand, and this hook writes the suppression the same moment —
  // no sweep to resurrect a removal a human made, no window for a contact
  // deletion to lose the address while an approved outbox row lives on.
  // Scoped to contacts outreach touched: a stranger's unrelated mail must
  // not suppress anyone.
  crmService.setOptOutSink((contactId, email) => {
    if (!outreachStore.hasOutreachHistory(contactId)) return;
    outreachStore.addSuppression(email, "reply-stop");
    outreachStore.optOutContact(contactId);
  });

  return {
    crmStore,
    crmService,
    automationStore,
    scheduler,
    outreachStore,
    engine,
    calendarStore,
    calendarService,
    archiveLog,
    start: () => {
      crmService.start();
      scheduler.start();
      engine.start();
    },
    stop: () => {
      engine.stop();
      scheduler.stop();
      crmService.stop();
    },
  };
}

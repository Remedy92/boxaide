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
import type { AgentLauncher } from "./agent/launcher.js";
import { CrmStore } from "./crm/store.js";
import { CrmService } from "./crm/service.js";
import { resolveOrgForContact } from "./crm/tools.js";
import { AutomationStore } from "./automation/store.js";
import { AutomationScheduler } from "./automation/scheduler.js";
import { OutreachStore } from "./outreach/store.js";
import { OutreachEngine } from "./outreach/engine.js";
import { CalendarStore } from "./calendar/store.js";
import { CalendarService } from "./calendar/service.js";
import { EnrichmentService } from "./enrichment/service.js";
import { ResearchService } from "./research/service.js";
import { ProspectingService } from "./prospecting/service.js";
import { ConnectorStore } from "./connectors/store.js";
import { ConnectorsService } from "./connectors/service.js";

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
  /** Paid address lookups and the CSV contact import. Stores nothing. */
  enrichmentService: EnrichmentService;
  /** Web search and page reads. No store, no key of its own, no timers. */
  researchService: ResearchService;
  /** Finding companies and people nobody named yet. Stores nothing. */
  prospectingService: ProspectingService;
  /** Provider API keys saved in settings, encrypted. Env stays the fallback. */
  connectorStore: ConnectorStore;
  /** Which provider keys this server has, and where each one came from. */
  connectorsService: ConnectorsService;
  /**
   * True when a search back end has a key today. Read live, so the launcher
   * can ask per launch: with no connector the CLI keeps its own web tools.
   */
  hasSearchConnector: () => boolean;
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
  /** Path to the macOS calendar helper, when the shell knows one. */
  calendarHelperPath?: string;
}): Platform {
  const crmStore = new CrmStore(opts.db, opts.masterKey);
  const crmService = new CrmService(crmStore, opts.mail);
  const automationStore = new AutomationStore(opts.db, opts.masterKey);
  const scheduler = new AutomationScheduler(automationStore, opts.launcher);
  const outreachStore = new OutreachStore(opts.db, opts.masterKey);
  // One key reader for both paid services. Settings beat the environment, and
  // every call re-reads SQLite, so a key added in the Connectors screen is in
  // force on the next lookup with no restart.
  const connectorStore = new ConnectorStore(opts.db, opts.masterKey);
  const connectorsService = new ConnectorsService(connectorStore);
  const getKey = (providerId: string) => connectorsService.getKey(providerId);
  // Enrichment never imports the CRM (spec invariant 6). It is handed one
  // callback instead, and this is the only place that knows both shapes: an
  // imported row names an organisation by text, the CRM wants an org id.
  const enrichmentService = new EnrichmentService({
    getKey,
    upsertContact: (row) => {
      // The same resolution crm_contact_upsert uses, not a second copy of it:
      // a row that carries a domain and no name points at an org rather than
      // naming one, so an existing org keeps its name instead of being renamed
      // to "acme.com", and a new one gets the derived name mail sync would
      // have given it.
      const org = resolveOrgForContact(
        crmStore,
        row.org ?? undefined,
        row.orgDomain ?? undefined,
      );
      const contact = crmStore.upsertContact({
        email: row.email,
        name: row.name,
        title: row.title,
        orgId: org?.id ?? null,
        source: "import",
      });
      // The CSV parser reads a tags column and the tool description promises
      // it, so the tags have to be written here: nothing else on this path
      // knows they exist, and a silently dropped tag makes every later search
      // by that tag miss the whole import.
      if (row.tags.length > 0) crmStore.addTags(contact.id, row.tags);
      return contact;
    },
  });
  // Research reaches the public web and keeps nothing, so it needs no db, no
  // master key, and no start/stop.
  const researchService = new ResearchService({ getKey });
  // Prospecting asks a vendor who exists. Like research it keeps nothing, so
  // it needs no db, no master key, and no start/stop.
  const prospectingService = new ProspectingService({ getKey });
  const engine = new OutreachEngine(outreachStore, crmStore, opts.mail, {
    // Deliverability check at the send chokepoint. The engine holds no
    // opinion about who does the checking: it asks this callback, and with
    // no provider key set the callback answers null and nothing changes.
    // The answer is cached by the enrichment service for a day, so a row
    // that waited behind the daily cap is not billed twice.
    verifyRecipient: async (email) => {
      if (!enrichmentService.isConfigured()) return null;
      const result = await enrichmentService.verifyEmail(email);
      return { status: result.status, confidence: result.confidence };
    },
  });
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
    enrichmentService,
    researchService,
    prospectingService,
    connectorStore,
    connectorsService,
    hasSearchConnector: () => connectorsService.hasSearchConnector(),
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

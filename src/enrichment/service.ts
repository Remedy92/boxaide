/**
 * Enrichment service: the provider waterfall, the billing cache, and the CSV
 * import path. Surface: docs/specs/agent-platform.md.
 *
 * Three rules shape this file.
 *
 * Every call here costs the operator money, so a repeated lookup is answered
 * from an in-memory cache for a day rather than billed twice. The cache holds
 * lookup answers only; it never holds message text, so nothing needs the
 * master key and nothing lands in SQLite.
 *
 * Calls run one at a time. Every one of these vendors rate limits per second,
 * and a burst of parallel lookups buys a 429 rather than a faster answer.
 *
 * The waterfall stops at the first decisive answer, which is either an address
 * good enough to use or a verdict that this one is dead. A provider that
 * throws does not stop it: a dead key on the first vendor must not take the
 * second one down with it, and the last error is reported only when every
 * provider failed.
 */
import { envNamed } from "../config.js";
import { HunterProvider } from "./hunter.js";
import { ProspeoProvider } from "./prospeo.js";
import { parseContactCsv, type ImportContactRow, type SkippedRow } from "./csv.js";
import type {
  EnrichmentProvider,
  EnrichmentResult,
  FindEmailQuery,
} from "./types.js";

/** A day. Long enough that a re-run of the same list is free. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Answers held at once. A cap rather than a TTL alone: the outreach engine now
 * verifies every recipient before its send, so one big campaign would otherwise
 * leave one entry per address resident until the day was up.
 */
const MAX_CACHE_ENTRIES = 5_000;

/**
 * Confidence at or above this ends the waterfall. Below it the next provider
 * gets a turn and the best answer of the run is returned, so a catch-all
 * domain still produces something a human can judge.
 */
const ACCEPT_CONFIDENCE = 80;

/** Names an operator sets, quoted back verbatim when none of them is set. */
export const HUNTER_ENV_KEY = "BOXAIDE_HUNTER_API_KEY";
export const PROSPEO_ENV_KEY = "BOXAIDE_PROSPEO_API_KEY";

const NOT_CONFIGURED = `no enrichment provider is configured. Add a key under Settings > Connectors, or set ${HUNTER_ENV_KEY} or ${PROSPEO_ENV_KEY} in the Boxaide environment.`;

/**
 * Writes one contact into the CRM. Injected by platform wiring so this module
 * never imports the CRM, which spec invariant 6 forbids. It returns whatever
 * the CRM calls a contact id; enrichment only passes it back to the caller.
 */
export type UpsertContact = (row: ImportContactRow) => { id: string };

export type EnrichmentDeps = {
  /**
   * Providers in waterfall order, fixed for the life of the service. Absent
   * means build them from the current keys on every call. An empty array is
   * not absent: it says this service has no providers at all.
   */
  providers?: EnrichmentProvider[];
  /**
   * Reads the API key for one provider id. Production passes the connectors
   * service, which answers from settings first and the environment second.
   * Read per call, so a key saved in Settings needs no restart.
   */
  getKey?: (providerId: string) => string | undefined;
  /** Injection seam for tests, so a cache expiry costs no wall time. */
  now?: () => number;
  upsertContact?: UpsertContact;
};

type CacheEntry = { at: number; result: EnrichmentResult };

export type ImportOutcome = {
  imported: { email: string; contactId: string }[];
  skipped: SkippedRow[];
};

export class EnrichmentService {
  /** Set only when the caller pinned an explicit provider list. */
  private fixedProviders: EnrichmentProvider[] | null;
  private getKey: (providerId: string) => string | undefined;
  private now: () => number;
  private upsertContact: UpsertContact | null;
  private cache = new Map<string, CacheEntry>();
  /**
   * Lookups already running, keyed the same way the cache is. The cache only
   * answers once a call has settled, so without this two callers who ask for
   * one address in the same tick both miss and the vendor bills twice.
   */
  private inFlight = new Map<string, Promise<EnrichmentResult>>();
  /** Tail of the in-flight chain, so two callers cannot overlap a vendor. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: EnrichmentDeps = {}) {
    this.fixedProviders = deps.providers ?? null;
    this.getKey = deps.getKey ?? ((id) => envNamed(envSuffixFor(id)));
    this.now = deps.now ?? Date.now;
    this.upsertContact = deps.upsertContact ?? null;
  }

  /** False when no API key is set. Every lookup refuses in that state. */
  isConfigured(): boolean {
    return this.providersNow().length > 0;
  }

  /** Provider ids in waterfall order. Shown to a human deciding what to buy. */
  configuredProviders(): string[] {
    return this.providersNow().map((p) => p.id);
  }

  /**
   * The waterfall as it stands right now. Rebuilt per call because a key can
   * arrive from the Connectors screen between two lookups, and a provider
   * object holds nothing but its key and a fetch, so rebuilding costs
   * nothing. Hunter leads because it reports a real score, so the waterfall
   * can judge its answer rather than trust it.
   */
  private providersNow(): EnrichmentProvider[] {
    if (this.fixedProviders) return this.fixedProviders;
    const providers: EnrichmentProvider[] = [];
    const hunter = this.getKey("hunter");
    if (hunter) providers.push(new HunterProvider(hunter));
    const prospeo = this.getKey("prospeo");
    if (prospeo) providers.push(new ProspeoProvider(prospeo));
    return providers;
  }

  async findEmail(query: FindEmailQuery): Promise<EnrichmentResult> {
    this.requireConfigured();
    const domain = query.domain.trim().toLowerCase();
    if (!domain) throw new Error("domain is required");
    const name = (query.fullName ?? `${query.firstName ?? ""} ${query.lastName ?? ""}`)
      .trim()
      .toLowerCase();
    if (!name) throw new Error("fullName, or firstName and lastName, is required");
    return this.waterfall(`find:${name}@${domain}`, (provider) =>
      provider.findEmail({ ...query, domain }),
    );
  }

  async verifyEmail(email: string): Promise<EnrichmentResult> {
    this.requireConfigured();
    const address = email.trim().toLowerCase();
    if (!address.includes("@")) throw new Error(`invalid email: ${email}`);
    return this.waterfall(`verify:${address}`, (provider) =>
      provider.verifyEmail(address),
    );
  }

  /**
   * Parse CSV and write every good row through the injected CRM callback.
   * Rows the parser rejected, and rows the CRM refused, come back together in
   * `skipped`: a caller should see one list of what did not land, not two.
   */
  importContacts(csv: string): ImportOutcome {
    if (!this.upsertContact) {
      throw new Error(
        "contact import is not wired to a CRM on this server; report this as a Boxaide bug",
      );
    }
    const parsed = parseContactCsv(csv);
    const imported: { email: string; contactId: string }[] = [];
    const skipped = [...parsed.skipped];
    for (const row of parsed.rows) {
      try {
        const contact = this.upsertContact(row);
        imported.push({ email: row.email, contactId: contact.id });
      } catch (err) {
        skipped.push({
          line: row.line,
          reason: err instanceof Error ? err.message : String(err),
          email: row.email,
        });
      }
    }
    return { imported, skipped };
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) throw new Error(NOT_CONFIGURED);
  }

  /**
   * Run the providers in order behind the serial queue, returning the first
   * answer worth keeping. `key` is the cache key; a hit skips the vendors and
   * the queue entirely, which is the point of paying for a cache at all.
   */
  private async waterfall(
    key: string,
    call: (provider: EnrichmentProvider) => Promise<EnrichmentResult>,
  ): Promise<EnrichmentResult> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.result;
    this.cache.delete(key);
    // The same lookup already on its way is the answer to this one too.
    const running = this.inFlight.get(key);
    if (running) return running;

    const run = this.queue.then(async () => {
      let best: EnrichmentResult | null = null;
      let lastError: unknown = null;
      for (const provider of this.providersNow()) {
        let result: EnrichmentResult;
        try {
          result = await call(provider);
        } catch (err) {
          lastError = err;
          continue;
        }
        if (!best || outranks(result, best)) best = result;
        // Both endings are decisive: a good enough address, or a provider that
        // proved this one dead. Neither can be improved on by paying another
        // vendor for a second opinion.
        if (result.email && (result.status === "invalid" || result.confidence >= ACCEPT_CONFIDENCE)) {
          break;
        }
      }
      if (!best) {
        throw lastError instanceof Error
          ? lastError
          : new Error(String(lastError ?? "enrichment failed"));
      }
      return this.remember(key, best);
    });
    // The queue must advance even when this call failed, or one bad lookup
    // would wedge every later one behind a rejected promise.
    this.queue = run.catch(() => undefined);
    this.inFlight.set(key, run);
    // then() with both handlers, not finally(): finally() returns a promise
    // that rejects with nothing attached, which is an unhandled rejection.
    void run.then(
      () => this.inFlight.delete(key),
      () => this.inFlight.delete(key),
    );
    return run;
  }

  /**
   * Keep one answer, bounded, and hand back the copy that was kept.
   *
   * `raw` is a whole vendor response, useful while the call that made it is
   * still on the stack and a leak once thousands of them are held for a day.
   * It is dropped here, and the lean copy is what the caller gets too: a
   * lookup must not answer with one shape on the call that paid for it and a
   * different shape on every cache hit for the next day.
   *
   * The cap is the bound that matters, so the sweep for expired entries only
   * runs once the map is full. Below the cap an entry past its day costs four
   * small fields and is dropped the next time its own key is asked for.
   */
  private remember(key: string, result: EnrichmentResult): EnrichmentResult {
    const now = this.now();
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      for (const [stale, entry] of this.cache) {
        if (now - entry.at >= CACHE_TTL_MS) this.cache.delete(stale);
      }
    }
    const lean: EnrichmentResult = {
      email: result.email,
      confidence: result.confidence,
      status: result.status,
      provider: result.provider,
    };
    this.cache.set(key, { at: now, result: lean });
    // Still full after the sweep: drop by insertion order, which is write
    // order here because waterfall deletes the key before it is written back.
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return lean;
  }
}

/**
 * Which of two answers the waterfall keeps.
 *
 * Confidence alone is the wrong test, and it fails in the one direction that
 * costs money. An 'invalid' verdict scores zero because there is nothing to be
 * confident in, not because the answer is weak: it is the most certain thing a
 * provider ever says. Picking on confidence would always throw it away in
 * favour of an earlier "risky, 70", and the pre-send guard in the outreach
 * engine only blocks on 'invalid', so a proven dead address would be mailed.
 * So a proven failure outranks every answer that did not already end the
 * waterfall, and everything else is compared on confidence.
 */
function outranks(candidate: EnrichmentResult, best: EnrichmentResult): boolean {
  const candidateProven = candidate.status === "invalid";
  const bestProven = best.status === "invalid";
  if (candidateProven !== bestProven) return candidateProven;
  return candidate.confidence > best.confidence;
}

/** The environment variable behind one provider id, minus the BOXAIDE_ prefix. */
function envSuffixFor(id: string): string {
  return id === "hunter" ? "HUNTER_API_KEY" : "PROSPEO_API_KEY";
}

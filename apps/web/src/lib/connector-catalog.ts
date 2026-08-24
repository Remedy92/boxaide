/**
 * What the Connectors screen knows about each provider beyond its id.
 *
 * The server sends the id, the label, the kind and whether a key is set. It
 * does not send what the provider costs, whether there is a free plan, or where
 * the key page is, because none of that is state — it is what somebody found
 * out by reading five pricing pages, and it belongs next to the screen that
 * shows it rather than in a REST payload.
 *
 * ---------------------------------------------------------------------------
 * Why these five, and which one to reach for first
 * ---------------------------------------------------------------------------
 *
 * Every figure below was read off the vendor's own pricing page on
 * 20 August 2026, and CHECKED_ON says so on the screen. They will drift. When
 * they do, the fix is to re-read the five pages linked from `pricingHref` and
 * edit this file; nothing else in the app depends on these numbers.
 *
 * Web search — Parallel first. Parallel is $1 per 1,000 search requests with
 * 5,000 requests a month free. Exa is $7 per 1,000 with a $10 monthly credit.
 * Both return page excerpts, which is what src/research/providers.ts asks for,
 * so this is the same job at a seventh of the price. Brave ($5/1,000, free tier
 * withdrawn in February 2026) and Tavily (~$8/1,000) are worse on both counts.
 * Serper is cheaper still, $0.30–$1.00 per 1,000, but it returns a result page
 * and no page text, so it would need a fetch per hit to do this job.
 *
 * The server agrees: allProviders() in src/research/providers.ts lists Parallel
 * before Exa, and src/research/service.ts takes the first configured provider
 * when a tool call names none. So a key on both searches through Parallel, and
 * Exa is reached by naming it.
 *
 * Email addresses — Hunter first, and it is not close on price to start. Hunter
 * gives 50 credits a month on a free plan, and its plan comparison marks API
 * access on every plan including Free. Prospeo's own comparison table marks
 * "Public API" as No access on Free: its API starts at Starter, $49 a month
 * ($37 billed yearly). Prospeo is a good second source — the two indexes miss
 * different people, and src/enrichment tries Prospeo when Hunter finds nothing
 * — but it is a second key, not a first one.
 *
 * Prospects — Apollo, and there is no close alternative at this price. The free
 * plan does include API access, capped at 600 calls a day and with last names
 * masked in People Search, so it is enough to see whether prospecting is useful
 * before paying for it. The alternatives at this job (People Data Labs,
 * Crustdata, ZoomInfo) start at enterprise contracts.
 *
 * With no Apollo key at all, the Hunter key already in for addresses answers
 * the prospecting tools instead: its Discover search finds companies for free,
 * and its domain search returns the people at a domain with their addresses
 * already attached. What it cannot do is the question Apollo is here for —
 * "everyone with this title, at any company" — because Hunter searches one
 * domain at a time. So Hunter is the floor, not a replacement.
 *
 * ---------------------------------------------------------------------------
 * Why there is no "Connect with one click" button
 * ---------------------------------------------------------------------------
 *
 * There is no OAuth path to any of these five for a self-hosted install, so a
 * one-click button would be a lie. Apollo has OAuth, but it is partner-only:
 * the app has to be registered with Apollo and has to name a fixed redirect
 * URL, which a copy of Boxaide running on somebody's laptop on a port they
 * chose cannot do. The other four issue keys from a dashboard page and nothing
 * else. Exa's hosted MCP endpoint speaks OAuth, but Boxaide calls Exa's REST
 * search API, which does not.
 *
 * So the shortest honest path is two clicks, and the panel is built around it:
 * "Get a key" opens the exact page that issues one, and a paste into the field
 * saves and checks in one motion — no Save button to find, no Check button to
 * remember. cleanPastedKey() in connector-key.ts takes the packaging off first,
 * so pasting a whole `.env` line works too.
 */

export type ConnectorFacts = {
  /** Path under public/. Served by Boxaide itself; nothing loads from a vendor. */
  logo: string;
  /** True for a single-colour mark that would vanish on the dark surface. */
  invertOnDark?: boolean;
  /** One line: what this provider does for an agent. */
  blurb: string;
  /** Where the key is issued. The whole point of the "Get a key" button. */
  keysHref: string;
  /** The vendor's own pricing page, behind the figures below. */
  pricingHref: string;
  /** What you get without paying, in a few words. */
  free: string;
  /** What it costs once the free part runs out. */
  paid: string;
  /**
   * The one thing about this provider that will otherwise surprise somebody
   * after they have paid or pasted. Null when there is nothing.
   */
  caveat: string | null;
  /**
   * Lower comes first inside a capability, and rank 0 is the one the section
   * recommends and opens. This is a judgement about price and free tier, made
   * in the header comment above, not an order the server sends.
   */
  rank: number;
  /**
   * What checking this key costs, when it costs anything. Two of the five have
   * no free way to test a key, and an operator is owed that before Boxaide
   * spends their money on their behalf.
   */
  checkCost?: string;
};

/** When the figures below were last read off the vendors' own pages. */
export const CHECKED_ON = "20 August 2026";

export const CATALOG: Record<string, ConnectorFacts> = {
  apollo: {
    logo: "/connectors/apollo.png",
    blurb:
      "Searches for companies and for the people who work at them, so an agent can find prospects you do not have yet.",
    keysHref: "https://app.apollo.io/#/settings/integrations/api",
    pricingHref: "https://www.apollo.io/pricing",
    free: "Free plan, API included",
    paid: "600 calls a day free; paid plans lift the cap",
    caveat:
      "On the free plan Apollo hides last names in search results. Paid plans return them.",
    rank: 0,
  },
  hunter: {
    logo: "/connectors/hunter.png",
    blurb:
      "Finds and verifies work email addresses from a name and a domain, and with no Apollo key it also finds companies and the people who work at them.",
    keysHref: "https://hunter.io/api-keys",
    pricingHref: "https://hunter.io/pricing",
    free: "50 lookups a month, free",
    paid: "€49 a month for 2,000, or €34 billed yearly",
    caveat: null,
    rank: 0,
  },
  prospeo: {
    logo: "/connectors/prospeo.png",
    blurb:
      "A second index for the same lookup. Boxaide tries it when Hunter finds nothing, so it is worth a key only once Hunter is in.",
    keysHref: "https://prospeo.io/api",
    pricingHref: "https://prospeo.io/pricing",
    free: "no free API",
    paid: "$49 a month, or $37 billed yearly",
    caveat:
      "Prospeo's free plan has no API access at all. A key needs the Starter plan or better.",
    rank: 1,
  },
  parallel: {
    logo: "/connectors/parallel.svg",
    invertOnDark: true,
    blurb: "Searches the web and returns page excerpts, for research on a person or a company.",
    keysHref: "https://platform.parallel.ai/settings/api-keys",
    pricingHref: "https://parallel.ai/pricing",
    free: "5,000 searches a month, free",
    paid: "$1 per 1,000 after that",
    caveat: null,
    rank: 0,
    checkCost:
      "Parallel has no free way to test a key, so a check runs one small search. That costs a fraction of a penny.",
  },
  exa: {
    logo: "/connectors/exa.svg",
    blurb: "The same job as Parallel, through a different index.",
    keysHref: "https://dashboard.exa.ai/api-keys",
    pricingHref: "https://exa.ai/pricing",
    free: "$10 of credit a month",
    paid: "$7 per 1,000 searches",
    caveat:
      "Seven times Parallel's price for the same search. If both have a key, Boxaide searches with Parallel and reaches Exa only when an agent names it.",
    rank: 1,
    checkCost:
      "Exa has no free way to test a key, so a check runs one small search. That costs a fraction of a penny.",
  },
};

/** The facts for one id, or undefined when the server offers one this page has never heard of. */
export function factsFor(id: string): ConnectorFacts | undefined {
  return CATALOG[id];
}

/** Recommended first, then by the server's own order. Never reorders unknowns to the front. */
export function byRank<T extends { id: string }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index, rank: CATALOG[row.id]?.rank ?? 99 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.row);
}

/**
 * Research module types: one normalised search result shape, and the provider
 * interface every search back end is adapted to.
 *
 * Module layout and seams: docs/specs/agent-platform.md.
 *
 * The normalised shape is deliberately small. Every provider returns more than
 * this (scores, ids, highlights, author guesses), and passing that through
 * would let an agent write logic against one vendor's extras and then break the
 * day the operator switches keys. Anything a caller genuinely needs is added
 * here first, for both providers, or not at all.
 */

/** One search hit, in the only shape the rest of Boxaide sees. */
export type SearchResult = {
  title: string;
  url: string;
  /** Short extract from the page. Empty string when the provider gave none. */
  snippet: string;
  /** ISO 8601 date the provider claims the page was published, when it says. */
  publishedDate?: string;
};

export type SearchOptions = {
  /** How many hits the caller wants. Providers may return fewer. */
  numResults: number;
};

/**
 * A search back end. `id` is what the web_search tool's `provider` argument
 * accepts, so it is lower case and stable, not a display name.
 */
export type SearchProvider = {
  id: string;
  /**
   * Whether this back end has an API key right now. Asked per call rather than
   * decided once at construction, because a key added to the environment of a
   * running serve process should start working without a restart.
   */
  isConfigured(): boolean;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
};

/** A page read back as text. */
export type FetchedPage = {
  /** The URL actually read, which is the last hop when redirects were followed. */
  url: string;
  title?: string;
  text: string;
  /** True when the page was longer than the character cap and was cut. */
  truncated: boolean;
};

import { describe, it, expect } from "vitest";
import { blockedAddressReason, parseFetchUrl } from "../src/research/safe-url.js";
import {
  extractTitle,
  fetchPage,
  htmlToText,
  MAX_PAGE_CHARS,
  MAX_REDIRECTS,
  type FetchPageDeps,
} from "../src/research/fetch-page.js";

type Hop = { url: string; headers: Record<string, string> };

/**
 * A fake web. `pages` maps an absolute URL to a response; anything not in the
 * map is a 404. `hosts` is the resolver, so a name can be pointed at any
 * address the test wants without touching real DNS.
 */
function stubWeb(
  pages: Record<string, Response | (() => Response)>,
  hosts: Record<string, string[]> = {},
): { deps: FetchPageDeps; hops: Hop[] } {
  const hops: Hop[] = [];
  const deps: FetchPageDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      hops.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      const entry = pages[url];
      if (!entry) return new Response("not found", { status: 404 });
      return typeof entry === "function" ? entry() : entry;
    }) as unknown as typeof globalThis.fetch,
    resolve: async (hostname: string) => {
      const answers = hosts[hostname];
      if (!answers) throw new Error(`no such host in test: ${hostname}`);
      return answers;
    },
  };
  return { deps, hops };
}

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

describe("blockedAddressReason", () => {
  it("blocks loopback, private, link-local and metadata addresses", () => {
    expect(blockedAddressReason("127.0.0.1")).toBe("loopback");
    expect(blockedAddressReason("127.1.2.3")).toBe("loopback");
    expect(blockedAddressReason("0.0.0.0")).toBe("unspecified");
    expect(blockedAddressReason("10.0.0.7")).toBe("private");
    expect(blockedAddressReason("172.16.0.1")).toBe("private");
    expect(blockedAddressReason("172.31.255.254")).toBe("private");
    expect(blockedAddressReason("192.168.1.10")).toBe("private");
    expect(blockedAddressReason("100.64.0.1")).toBe("carrier-grade nat");
    expect(blockedAddressReason("169.254.169.254")).toBe("link-local or cloud metadata");
    expect(blockedAddressReason("224.0.0.1")).toBe("multicast or reserved");
    expect(blockedAddressReason("255.255.255.255")).toBe("multicast or reserved");
  });

  it("lets ordinary public addresses through", () => {
    expect(blockedAddressReason("93.184.216.34")).toBeNull();
    expect(blockedAddressReason("8.8.8.8")).toBeNull();
    expect(blockedAddressReason("172.32.0.1")).toBeNull();
    expect(blockedAddressReason("2606:2800:220:1:248:1893:25c8:1946")).toBeNull();
  });

  it("blocks the IPv6 equivalents, mapped IPv4 included", () => {
    expect(blockedAddressReason("::1")).toBe("loopback");
    expect(blockedAddressReason("::")).toBe("unspecified");
    expect(blockedAddressReason("fd00::1")).toBe("unique local");
    expect(blockedAddressReason("fe80::1")).toBe("link-local");
    expect(blockedAddressReason("ff02::1")).toBe("multicast");
    expect(blockedAddressReason("::ffff:127.0.0.1")).toBe("loopback");
    expect(blockedAddressReason("::ffff:169.254.169.254")).toBe("link-local or cloud metadata");
  });

  it("fails closed on anything it cannot parse", () => {
    expect(blockedAddressReason("not-an-ip")).toBe("unparseable address");
    expect(blockedAddressReason("")).toBe("unparseable address");
  });
});

describe("parseFetchUrl", () => {
  it("refuses every scheme but http and https", () => {
    expect(() => parseFetchUrl("file:///etc/passwd")).toThrow(/must be http or https/);
    expect(() => parseFetchUrl("ftp://example.com/x")).toThrow(/must be http or https/);
    expect(() => parseFetchUrl("data:text/html,hi")).toThrow(/must be http or https/);
    expect(() => parseFetchUrl("not a url")).toThrow(/not a valid absolute URL/);
  });

  it("refuses loopback and internal host names before any lookup", () => {
    expect(() => parseFetchUrl("http://localhost:8787/api/accounts")).toThrow(/loopback name/);
    expect(() => parseFetchUrl("http://app.localhost/x")).toThrow(/loopback name/);
    expect(() => parseFetchUrl("http://printer.local/")).toThrow(/internal name/);
    expect(() => parseFetchUrl("http://db.internal/")).toThrow(/internal name/);
  });

  it("accepts a normal public URL", () => {
    expect(parseFetchUrl("https://example.com/a?b=c").hostname).toBe("example.com");
  });
});

describe("fetchPage SSRF guard", () => {
  it("refuses a literal loopback address", async () => {
    const { deps, hops } = stubWeb({});
    await expect(fetchPage("http://127.0.0.1:8787/api/accounts", deps)).rejects.toThrow(
      /blocked address: 127.0.0.1 \(loopback\)/,
    );
    expect(hops).toHaveLength(0);
  });

  it("refuses the cloud metadata address", async () => {
    const { deps, hops } = stubWeb({});
    await expect(
      fetchPage("http://169.254.169.254/latest/meta-data/iam/security-credentials/", deps),
    ).rejects.toThrow(/link-local or cloud metadata/);
    expect(hops).toHaveLength(0);
  });

  it("refuses a decimal-encoded loopback address", async () => {
    const { deps } = stubWeb({});
    await expect(fetchPage("http://2130706433/", deps)).rejects.toThrow(/loopback/);
  });

  it("refuses an IPv6 loopback literal", async () => {
    const { deps } = stubWeb({});
    await expect(fetchPage("http://[::1]/", deps)).rejects.toThrow(/blocked address: ::1/);
  });

  it("refuses a public name that resolves into a private range", async () => {
    const { deps, hops } = stubWeb({}, { "intranet.example.com": ["10.1.2.3"] });
    await expect(fetchPage("https://intranet.example.com/", deps)).rejects.toThrow(
      /resolves to a blocked address: intranet.example.com -> 10.1.2.3 \(private\)/,
    );
    expect(hops).toHaveLength(0);
  });

  it("refuses a name with one public and one loopback answer", async () => {
    const { deps } = stubWeb({}, { "split.example.com": ["93.184.216.34", "127.0.0.1"] });
    await expect(fetchPage("https://split.example.com/", deps)).rejects.toThrow(/loopback/);
  });

  it("refuses a redirect into a private address", async () => {
    const { deps, hops } = stubWeb(
      {
        "https://public.example.com/": () =>
          new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
      },
      { "public.example.com": ["93.184.216.34"] },
    );
    await expect(fetchPage("https://public.example.com/", deps)).rejects.toThrow(
      /link-local or cloud metadata/,
    );
    // The first hop happened; the second was refused before any request.
    expect(hops).toHaveLength(1);
  });

  it("refuses a relative redirect onto a host that resolves privately", async () => {
    const { deps } = stubWeb(
      {
        "https://a.example.com/": () =>
          new Response(null, { status: 301, headers: { location: "https://b.example.com/x" } }),
      },
      { "a.example.com": ["93.184.216.34"], "b.example.com": ["192.168.0.9"] },
    );
    await expect(fetchPage("https://a.example.com/", deps)).rejects.toThrow(/private/);
  });

  it("gives up after the redirect limit", async () => {
    const pages: Record<string, () => Response> = {};
    for (let i = 0; i <= MAX_REDIRECTS + 2; i++) {
      pages[`https://loop.example.com/${i}`] = () =>
        new Response(null, { status: 302, headers: { location: `/${i + 1}` } });
    }
    const { deps } = stubWeb(pages, { "loop.example.com": ["93.184.216.34"] });
    await expect(fetchPage("https://loop.example.com/0", deps)).rejects.toThrow(
      new RegExp(`too many redirects \\(limit ${MAX_REDIRECTS}\\)`),
    );
  });
});

describe("fetchPage reading", () => {
  const hosts = { "acme.example": ["93.184.216.34"] };

  it("returns readable text, the title and an honest user agent", async () => {
    const { deps, hops } = stubWeb(
      {
        "https://acme.example/about": html(
          "<html><head><title>About Acme</title></head><body><nav>Home</nav><p>We make anvils.</p><script>track()</script></body></html>",
        ),
      },
      hosts,
    );
    const page = await fetchPage("https://acme.example/about", deps);

    expect(page.url).toBe("https://acme.example/about");
    expect(page.title).toBe("About Acme");
    expect(page.text).toContain("We make anvils.");
    expect(page.text).not.toContain("track()");
    expect(page.truncated).toBe(false);
    expect(hops[0].headers["user-agent"]).toMatch(/^Boxaide\/\d+\.\d+\.\d+ /);
  });

  it("follows a redirect and reports the final url", async () => {
    const { deps } = stubWeb(
      {
        "https://acme.example/old": () =>
          new Response(null, { status: 301, headers: { location: "/new" } }),
        "https://acme.example/new": html("<p>moved here</p>"),
      },
      hosts,
    );
    const page = await fetchPage("https://acme.example/old", deps);
    expect(page.url).toBe("https://acme.example/new");
    expect(page.text).toBe("moved here");
  });

  it("truncates a long page and says so", async () => {
    const body = `<p>${"anvil ".repeat(20_000)}</p>`;
    const { deps } = stubWeb({ "https://acme.example/long": html(body) }, hosts);
    const page = await fetchPage("https://acme.example/long", deps);
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(MAX_PAGE_CHARS);
  });

  it("does not claim truncation for a page just under the cap", async () => {
    const { deps } = stubWeb({ "https://acme.example/short": html("<p>hello</p>") }, hosts);
    const page = await fetchPage("https://acme.example/short", deps);
    expect(page.truncated).toBe(false);
    expect(page.text).toBe("hello");
  });

  it("refuses a body that is not text", async () => {
    const { deps } = stubWeb(
      {
        "https://acme.example/report.pdf": () =>
          new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }),
      },
      hosts,
    );
    await expect(fetchPage("https://acme.example/report.pdf", deps)).rejects.toThrow(
      /not readable text \(content-type application\/pdf\)/,
    );
  });

  it("reports an HTTP error with its status", async () => {
    const { deps } = stubWeb({}, hosts);
    await expect(fetchPage("https://acme.example/missing", deps)).rejects.toThrow(
      /fetch failed with HTTP 404/,
    );
  });

  it("reports a transport failure without swallowing it", async () => {
    const deps: FetchPageDeps = {
      fetch: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof globalThis.fetch,
      resolve: async () => ["93.184.216.34"],
    };
    await expect(fetchPage("https://acme.example/x", deps)).rejects.toThrow(
      /fetch failed: socket hang up/,
    );
  });

  it("reports a host it cannot resolve", async () => {
    const { deps } = stubWeb({}, {});
    await expect(fetchPage("https://nowhere.example/", deps)).rejects.toThrow(
      /host could not be resolved: nowhere.example/,
    );
  });
});

describe("htmlToText", () => {
  it("leaves a numeric entity that names no character as written", () => {
    // String.fromCodePoint throws above U+10FFFF, and one of these in a
    // corrupted page used to take the whole read down with it.
    expect(htmlToText("<p>gone &#99999999; here</p>")).toBe("gone &#99999999; here");
    expect(htmlToText("<p>&#xFFFFFFFF;</p>")).toBe("&#xFFFFFFFF;");
    expect(htmlToText("<p>caf&#233;</p>")).toBe("café");
  });

  it("stays fast on markup that never closes a tag", () => {
    // The regex this replaced took 72 seconds on this input and half an hour
    // at the byte cap, with the whole single-process server stopped for it.
    const started = Date.now();
    htmlToText("<".repeat(400_000));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stays fast on an unterminated script tag", () => {
    const started = Date.now();
    htmlToText("<script ".repeat(200_000));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not swallow the page when a dropped element never closes", () => {
    expect(htmlToText("<p>keep me</p><script src=x.js>")).toBe("keep me");
  });

  it("keeps a trailing bare less-than sign as the prose it is", () => {
    expect(htmlToText("<p>7 < 8")).toBe("7 < 8");
  });
});

describe("extractTitle", () => {
  it("reads a title and stays fast on markup that never closes one", () => {
    expect(extractTitle("<html><head><title>About Acme</title></head></html>")).toBe(
      "About Acme",
    );
    expect(extractTitle("<html><body>no title</body></html>")).toBeUndefined();
    const started = Date.now();
    expect(extractTitle("<title ".repeat(200_000))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

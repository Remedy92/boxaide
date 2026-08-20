/**
 * The SSRF guard for web_fetch. Everything the research module is ever going
 * to point at the network goes through here first.
 *
 * Why this file exists at all: web_fetch takes a URL from an agent, and an
 * agent takes URLs from whatever it just read. A page, an email or a search
 * snippet can therefore choose the address Boxaide connects to. Boxaide runs
 * self-hosted, usually on the same machine or the same LAN as the user's
 * mailbox, its own API on 127.0.0.1, and on a cloud box the instance metadata
 * service on 169.254.169.254. Fetching any of those on request would turn a
 * research tool into a read primitive on the operator's private network.
 *
 * So the rule is a deny list of address ranges rather than a deny list of
 * names: names are attacker-chosen and a name can point anywhere. We refuse
 * when any address the host answers with is private, and repeat the whole check
 * on every redirect hop, because a public host is free to redirect to 127.0.0.1
 * and the second request is the one that matters.
 *
 * Where the check happens is the point. `vettingLookup` is the guard: it is
 * handed to node:http and node:https as the request's `lookup`, so the one
 * resolution it vets is the same resolution the socket connects with. A name
 * that changes its answer between two lookups (DNS rebinding) has nothing to
 * change here, because there is no second lookup between the check and the
 * connect. `assertPublicHost` still runs first, but only to refuse an obvious
 * address with a friendly message before a socket exists, and to catch the one
 * case the hook never sees: a URL with an IP literal in it, which Node connects
 * to without calling `lookup` at all. The hook is the guard; the pre-check is a
 * courtesy.
 */
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

/** Schemes we will fetch. Everything else, file: and data: included, is out. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Host names refused before any lookup happens. A resolver that answers
 * "localhost" with a public address is either broken or hostile, and neither
 * is worth honouring.
 */
function blockedHostName(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return "empty host";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback name";
  if (host.endsWith(".local") || host.endsWith(".internal")) return "internal name";
  return null;
}

/** Resolves a host name to every address it answers with. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/**
 * The real resolver. `all: true` matters: a host that answers with one public
 * address and one loopback address must be refused, and a single-answer lookup
 * would show us whichever one the resolver felt like putting first.
 */
export const dnsHostResolver: HostResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

function ipv4Bytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * Every IPv4 range that is not "somewhere on the public internet". Named so a
 * refusal can say which rule caught it, which is the difference between an
 * agent retrying forever and an agent telling the user what happened.
 */
function blockedIpv4(bytes: number[]): string | null {
  const [a, b] = bytes;
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade nat";
  if (a === 169 && b === 254) return "link-local or cloud metadata";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 192 && bytes[1] === 0 && bytes[2] === 0) return "reserved";
  if (a === 192 && bytes[1] === 0 && bytes[2] === 2) return "documentation";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking";
  if (a === 198 && b === 51 && bytes[2] === 100) return "documentation";
  if (a === 203 && b === 0 && bytes[2] === 113) return "documentation";
  if (a >= 224) return "multicast or reserved";
  return null;
}

/** Expands an IPv6 literal to its sixteen bytes. Returns null when unparseable. */
function ipv6Bytes(ip: string): number[] | null {
  let text = ip;
  // An IPv4-mapped or IPv4-compatible tail (::ffff:127.0.0.1) is written in
  // dotted quad. Rewrite it into two hextets so one parser handles both.
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const v4 = ipv4Bytes(tail[1]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, tail.index)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tailParts = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tailParts.length).fill("0"), ...tailParts]
      : head;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/**
 * The IPv4 address an IPv6 address carries inside it, or null when it carries
 * none.
 *
 * Four encodings, not one. ::ffff:a.b.c.d is the only form most guards check,
 * and each of the others reaches the same IPv4 address on a host configured
 * for it: ::a.b.c.d is the deprecated IPv4-compatible form, 64:ff9b::a.b.c.d
 * is the well-known NAT64 prefix, and 2002:aabb:ccdd:: is 6to4. Judging any of
 * them on its own bytes says "ordinary public IPv6" about 127.0.0.1.
 */
function embeddedIpv4(bytes: number[]): number[] | null {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  // ::ffff:a.b.c.d — IPv4-mapped.
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12);
  // ::ffff:0:a.b.c.d — IPv4-translated.
  if (zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zeros(10, 12)) {
    return bytes.slice(12);
  }
  // ::a.b.c.d — IPv4-compatible, deprecated but still routable by tunnels.
  // ::, ::1 and the other tiny reserved addresses are left to the rules below.
  if (zeros(0, 12) && !zeros(12, 16) && bytes[12] !== 0) return bytes.slice(12);
  // 64:ff9b::a.b.c.d and 64:ff9b:1::a.b.c.d — NAT64 well-known prefixes.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return bytes.slice(12);
  }
  // 2002:aabb:ccdd:: — 6to4, which carries the address in bytes 2 to 5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6);
  return null;
}

function blockedIpv6(bytes: number[]): string | null {
  // An IPv4 address wearing a hat is judged as an IPv4 address, whichever hat
  // it is wearing, or ::ffff:127.0.0.1 and its three cousins walk straight
  // past every rule below.
  const embedded = embeddedIpv4(bytes);
  if (embedded) {
    const reason = blockedIpv4(embedded);
    if (reason) return reason;
  }
  if (bytes.every((b) => b === 0)) return "unspecified";
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return "loopback";
  if ((bytes[0] & 0xfe) === 0xfc) return "unique local";
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "link-local";
  if (bytes[0] === 0xff) return "multicast";
  return null;
}

/**
 * Why this address is off limits, or null when it is a normal public address.
 * An address we cannot parse is refused: failing closed on a shape we do not
 * understand is the only safe direction here.
 */
export function blockedAddressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    return bytes ? blockedIpv4(bytes) : "unparseable address";
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    return bytes ? blockedIpv6(bytes) : "unparseable address";
  }
  return "unparseable address";
}

/**
 * Parses and syntax-checks one URL. Throws with a message the agent can act on,
 * because "blocked" with no reason gets retried and a named reason does not.
 */
export function parseFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`url is not a valid absolute URL: ${raw}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`url must be http or https, not ${url.protocol.replace(":", "")}`);
  }
  const nameReason = blockedHostName(url.hostname);
  if (nameReason) {
    throw new Error(`url host is not allowed: ${url.hostname} (${nameReason})`);
  }
  return url;
}

/**
 * Resolves the host and throws when any answer is a private address. Call it
 * once per hop, never once per request: the redirect target is a new host and
 * gets the same scrutiny as the first one.
 */
export async function assertPublicHost(url: URL, resolve: HostResolver): Promise<void> {
  // A literal in the URL never reaches the resolver, so check it directly.
  // WHATWG URL wraps an IPv6 literal in brackets; strip them before parsing.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    const reason = blockedAddressReason(host);
    if (reason) throw new Error(`url points at a blocked address: ${host} (${reason})`);
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new Error(`url host could not be resolved: ${host}`);
  }
  if (addresses.length === 0) throw new Error(`url host could not be resolved: ${host}`);
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) {
      throw new Error(`url resolves to a blocked address: ${host} -> ${address} (${reason})`);
    }
  }
}

/**
 * The guard itself, shaped as the `lookup` option of a node:http or node:https
 * request. Node calls it once per request and connects to exactly what it hands
 * back, so an address that passes here is the address the socket uses. That is
 * the whole difference from checking first and connecting afterwards.
 *
 * Every answer is vetted, not just the first. Node attempts them in turn
 * (happy eyeballs is on, and it asks with `all: true`), so one private address
 * in an otherwise public answer is enough to refuse the lot.
 *
 * The error text matches assertPublicHost's, because both end up in front of an
 * agent and one refusal reading two different ways helps nobody.
 */
export function vettingLookup(resolve: HostResolver): LookupFunction {
  return (hostname, options, callback) => {
    const host = hostname.replace(/^\[|\]$/g, "");
    void (async () => {
      let addresses: string[];
      try {
        addresses = await resolve(host);
      } catch {
        callback(new Error(`url host could not be resolved: ${host}`), "", 0);
        return;
      }
      if (addresses.length === 0) {
        callback(new Error(`url host could not be resolved: ${host}`), "", 0);
        return;
      }
      const answers: { address: string; family: number }[] = [];
      for (const address of addresses) {
        const reason = blockedAddressReason(address);
        if (reason) {
          callback(
            new Error(`url resolves to a blocked address: ${host} -> ${address} (${reason})`),
            "",
            0,
          );
          return;
        }
        answers.push({ address, family: isIP(address) });
      }
      // `all` is not decoration: answer the shape the caller asked for or Node
      // rejects the request with "Invalid IP address: undefined".
      if (options.all) callback(null, answers);
      else callback(null, answers[0].address, answers[0].family);
    })();
  };
}

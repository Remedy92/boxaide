/**
 * One URL-or-host string folded onto the bare domain that the CRM keys
 * organisations by.
 *
 * Shared rather than copied, because copies of this disagree. Two of them grew
 * in one change: the CSV import stripped any scheme and a trailing port and
 * required a dot, the Apollo adapter stripped only http and https and kept the
 * port. A "website" of `acme.com:8443` therefore folded to `acme.com` on one
 * path and stayed `acme.com:8443` on the other, and the CRM ended up with two
 * organisation rows for one company. Anything that matches organisations by
 * domain has to fold the same way or it does not match at all.
 */
export function bareDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  // Any scheme, not only http and https: a pasted cell holds what it holds.
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Everything from the first path, query or fragment character onward.
  host = host.split(/[/?#]/, 1)[0] ?? "";
  // Credentials in front of the host are not part of it.
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  host = host.replace(/^www\./, "").replace(/:\d+$/, "");
  // A host with no dot is a machine on somebody's LAN, a typo, or a word. The
  // CRM keys organisations by public domain, and none of the three is one.
  if (host === "" || !host.includes(".")) return null;
  return host;
}

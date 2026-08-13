"use client";

import { useQuery } from "@tanstack/react-query";
import {
  getCrmContact,
  listCrmContacts,
  listCrmOrgs,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * The People view's reads.
 *
 * The contact list is one request per (query, tag) pair rather than a
 * client-side filter over a full download: the endpoint does the LIKE in SQL
 * and caps at 200, and a CRM derived from years of mail is not a list this app
 * should hold in memory to grep.
 *
 * `query` here is the DEBOUNCED text. The raw keystrokes live in
 * use-app-state's own context so typing does not re-key the query on every
 * character.
 */
export function useCrmContacts(opts: {
  query?: string;
  tag?: string;
  /** False in every view but People — no request at all, not a disabled one. */
  enabled?: boolean;
}) {
  const ctx = useApiCtx();
  const enabled = opts.enabled ?? true;
  const query = opts.query?.trim() ?? "";
  const tag = opts.tag ?? "";
  return useQuery({
    queryKey: ["crm-contacts", ctx.baseUrl, ctx.token, query, tag],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) =>
      listCrmContacts(
        { query: query || undefined, tag: tag || undefined, limit: 200 },
        { ...ctx, signal },
      ),
    staleTime: 30_000,
  });
}

/**
 * One contact, with its tags, notes, interactions and deals. The response is
 * the detail object itself — the CRM's one unwrapped body.
 */
export function useCrmContact(contactId: string | null) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["crm-contact", ctx.baseUrl, ctx.token, contactId],
    enabled:
      contactId !== null && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) =>
      getCrmContact(contactId as string, { ...ctx, signal }, 50),
    staleTime: 30_000,
  });
}

/** Organizations, for the contact and deal forms. Rarely changes. */
export function useCrmOrgs(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["crm-orgs", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listCrmOrgs({ ...ctx, signal }),
    staleTime: 5 * 60_000,
  });
}

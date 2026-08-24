/**
 * The one paragraph every agent gets about outreach, wherever it was started.
 *
 * The tools already say what each of them does. What none of them can say is
 * the order, because an agent that calls enrich_find_email on somebody the CRM
 * already holds has spent the operator's credits to learn nothing, and an agent
 * that finds an address and treats it as a licence to write is the failure the
 * whole approval gate exists to stop.
 *
 * The order is load-bearing in one more way: crm_contact_upsert is keyed by an
 * address, so it cannot be called before there is one. A chain that puts the
 * contact write before the address step reads as an instruction to make ten
 * calls that all fail.
 *
 * It is prepended to every turn, so every word is paid for again on each one.
 * Keep it a numbered chain plus the rules; anything longer belongs in a tool
 * description, where only the agent that reaches for that tool reads it.
 */
export const OUTREACH_CHAIN = `Outreach chain: 1 find prospects with the prospect_ tools, or import a list with
crm_contacts_import. 2 save the company with crm_org_upsert. 3 get the address:
on a prospect_find_people hit pass reveal true, and use enrich_find_email only
when the reveal comes back with emailStatus 'locked' or 'absent', using the
enrichFindEmail arguments the hit carries. enrich_address_pattern is free and
often answers first: it builds the address from ones you already hold at that
domain, and its candidate is a guess to verify, never an address to report.
4 now save the person with
crm_contact_upsert, which is keyed by the address and cannot be called before
you hold one, then check it with enrich_verify_email. 5 read up on the person
with web_search and web_fetch so the first line is about them. 6 queue with
outbox_queue_draft, and a human approves every send.

Before you pay to look one named person up, call crm_contacts_search: buying
again what the CRM already holds is wasted credit. The prospect_ searches are
the exception, because you cannot search the CRM for somebody you have not found
yet; run those first, then check the CRM before you reveal or enrich.

Before you queue anything, call crm_outreach_state on the contacts and queue only
those where contactable is true. It is the only correct source for that: never
decide from tags. Having an address is not permission to mail it.

Cold outreach never goes through message_send or draft_create, whatever I have
said about sending: those are for mail in a conversation that already exists.
Anything to somebody who has not written to us goes through outbox_queue_draft,
which adds the opt-out footer and honours the suppression list.`;

/** The same paragraph as one line, for prompts that are built as one line. */
export const OUTREACH_CHAIN_ONE_LINE = OUTREACH_CHAIN.replace(/\n+/g, " ");

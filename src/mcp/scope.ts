/**
 * What a caller of this MCP server is allowed to do.
 *
 * Boxaide launches agent CLIs and hands each one a credential. Before this
 * module the credential was the master bearer and the only boundary was the
 * CLI's own per-tool allowlist — so an agent could be launched at all only if
 * its CLI happened to offer one. Two of the four installed CLIs do not, and
 * they were listed in the UI as "soon" for that reason alone.
 *
 * The boundary lives here instead. A launch mints a token bound to a profile,
 * this server refuses everything outside it, and the CLI's own flags become
 * defence in depth rather than the wall. That is what makes a CLI with no
 * allowlist flag safe to launch, and it is why the rule stays true for the
 * next CLI nobody has written a spec for yet.
 *
 * The profiles mirror the three ways Boxaide starts an agent. They are named
 * for who owns the conversation, because that is the only axis on which they
 * differ besides the schedule:
 *  - `chat`   the launched model runs the chat loop itself.
 *  - `driven` a driver in this process runs the loop; the model may read the
 *             conversation back but must not take a message out from under it.
 *  - `run`    a scheduled automation. No user to talk to, and the schedule is
 *             read-only to it.
 *
 * No profile sends mail or books a meeting. Every profile may ASK to, and a
 * person answers — see src/agent/approvals.ts for why that replaced taking the
 * tools away.
 *
 * A caller with no profile — the master bearer, or the stdio server a user
 * wired into their own desktop client — is unrestricted, exactly as before.
 */
import { CRM_TOOL_NAMES } from "../crm/tools.js";
import { AUTOMATION_TOOL_NAMES } from "../automation/tools.js";
import { OUTREACH_TOOL_NAMES } from "../outreach/tools.js";
import {
  CALENDAR_READ_TOOL_NAMES,
  CALENDAR_SEND_TOOL_NAMES,
} from "../calendar/tools.js";

export type ScopeProfile = "chat" | "driven" | "run";

/** Every profile there is, for tests and for iterating the set. */
export const SCOPE_PROFILES: readonly ScopeProfile[] = ["chat", "driven", "run"];

export function isScopeProfile(value: unknown): value is ScopeProfile {
  return (
    typeof value === "string" &&
    (SCOPE_PROFILES as readonly string[]).includes(value)
  );
}

/**
 * Every mail and chat tool. Deliberately hand-written and not "all of TOOLS":
 * adding a tool to the server must not silently grant it to every launched
 * agent.
 */
const BASE_TOOL_NAMES = [
  "accounts_list",
  "messages_list",
  "messages_search",
  "message_get",
  "message_mark_read",
  "draft_create",
  "draft_update",
  "drafts_list",
  "draft_delete",
  "folders_list",
  "message_send",
  "chat_await_message",
  "chat_say",
  "chat_activity",
  "chat_history",
];

/**
 * The chat loop's own tools: taking a message, answering it, narrating it.
 *
 * A driven session must not have these — the driver holds the lease, and a
 * second asker on one channel answers the same message twice. A scheduled run
 * must not either: it has nobody to talk to.
 */
const LOOP_TOOL_NAMES = new Set([
  "chat_await_message",
  "chat_say",
  "chat_activity",
]);

/**
 * Reading the conversation back. Not a loop tool: it takes no lease and posts
 * nothing, and it is the only way a driven session that lost its own transcript
 * can recover what was already said. A scheduled run still does not get it —
 * the chat is the user's, and a run has no part in it.
 */
const HISTORY_TOOL_NAME = "chat_history";

const CHAT_TOOL_NAMES = new Set([...LOOP_TOOL_NAMES, HISTORY_TOOL_NAME]);

/** Automation tools a run may call: reads only. It must not edit the schedule. */
const RUN_AUTOMATION_READ_TOOLS = ["automations_list", "automation_runs_list"];

/**
 * The one place that decides what a profile may call.
 *
 * Computed per call rather than frozen at import, so the answer is honest
 * about the tool modules at the moment it is asked.
 *
 * The sending tools — message_send, meeting_create, meeting_cancel — are in
 * every profile, and none of them sends anything. A scoped caller reaching one
 * queues it for a human instead; see src/agent/approvals.ts. That is why the
 * old blanket deletion at the bottom of this function is gone: taking the
 * tools away also took away the reason to launch an agent at an inbox, and the
 * risk they carry is answered by the person who reads the card, not by a name
 * missing from a list.
 */
export function scopeToolNames(profile: ScopeProfile): string[] {
  const chat: "loop" | "history" | "none" =
    profile === "chat" ? "loop" : profile === "driven" ? "history" : "none";
  const names = new Set<string>();
  for (const name of BASE_TOOL_NAMES) {
    if (!CHAT_TOOL_NAMES.has(name)) names.add(name);
    else if (chat === "loop") names.add(name);
    else if (chat === "history" && name === HISTORY_TOOL_NAME) names.add(name);
  }
  for (const name of CRM_TOOL_NAMES) names.add(name);
  for (const name of AUTOMATION_TOOL_NAMES) {
    if (profile !== "run" || RUN_AUTOMATION_READ_TOOLS.includes(name)) {
      names.add(name);
    }
  }
  for (const name of OUTREACH_TOOL_NAMES) names.add(name);
  for (const name of CALENDAR_READ_TOOL_NAMES) names.add(name);
  for (const name of CALENDAR_SEND_TOOL_NAMES) names.add(name);
  return [...names];
}

/** Cached per profile: this is asked once per tool call and once per list. */
const cache = new Map<ScopeProfile, ReadonlySet<string>>();

function toolSet(profile: ScopeProfile): ReadonlySet<string> {
  let hit = cache.get(profile);
  if (!hit) {
    hit = new Set(scopeToolNames(profile));
    cache.set(profile, hit);
  }
  return hit;
}

/**
 * The single enforcement predicate. `null` is the unrestricted caller.
 *
 * Both the tool listing and the call path go through this, and they must:
 * hiding a tool from the list is a hint, and a model that has seen the name
 * once will call it anyway.
 */
export function scopeAllows(
  profile: ScopeProfile | null | undefined,
  tool: string,
): boolean {
  if (!profile) return true;
  return toolSet(profile).has(tool);
}

/** What a refused call tells the model. It should read as a rule, not a bug. */
export function scopeRefusal(profile: ScopeProfile, tool: string): string {
  return `${tool} is not available to this agent: Boxaide launched it with the '${profile}' scope, which excludes that tool. This is a boundary, not a temporary failure — do not retry it.`;
}

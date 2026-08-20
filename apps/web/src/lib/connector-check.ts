/**
 * What a connector row and the capability strip above it are allowed to say.
 *
 * The rule this file exists to hold: a key is only "working" once a provider
 * has answered a real call with it. Saving a key proves nothing, because the
 * server stores whatever string it is given, and a green light on an untested
 * key is a promise the screen cannot keep. So there are four row states, not
 * two, and the strip at the top counts only the working ones.
 *
 * "Could not reach" is deliberately its own state and never red. The provider
 * being down says nothing about the key, and telling somebody to re-copy a key
 * that is already correct costs them an afternoon and a trip to the vendor.
 *
 * Pure on purpose: the panel renders these, and the words are worth a test.
 */
import { formatReaderDate } from "@/lib/format/date";
import type { Connector, ConnectorCheck } from "@/lib/types";

export type ConnectorTone = "success" | "danger" | "warning" | "accent" | "muted";

export type ConnectorStatusView = {
  tone: ConnectorTone;
  /** The state, in words. Never carried by the dot alone. */
  headline: string;
  /** The provider's own reason, when it gave one. */
  reason: string | null;
  /** The next thing to do, or null when there is nothing to do. */
  hint: string | null;
  /** True while a probe is in flight, so the row can show a spinner. */
  busy: boolean;
};

/** What one row says about the key it holds. */
export function connectorStatus(
  connector: Connector,
  check: ConnectorCheck | undefined,
  checking: boolean,
  now: Date = new Date(),
): ConnectorStatusView {
  if (checking) {
    return {
      tone: "accent",
      headline: "Checking the key with the provider…",
      reason: null,
      hint: null,
      busy: true,
    };
  }
  if (!connector.configured) {
    return { tone: "muted", headline: "No key yet", reason: null, hint: null, busy: false };
  }
  if (!check) {
    return {
      tone: "accent",
      headline: "Key saved, not checked yet",
      reason: null,
      hint: "Press Check to ask the provider whether this key works.",
      busy: false,
    };
  }
  const when = formatReaderDate(check.checkedAt, now);
  if (check.verdict === "works") {
    return {
      tone: "success",
      headline: "Working",
      reason: null,
      hint: when === "" ? null : `Checked ${when}.`,
      busy: false,
    };
  }
  if (check.verdict === "rejected") {
    return {
      tone: "danger",
      headline: "The provider refused this key",
      reason: check.reason,
      hint: "Check that you copied the whole key, and that it is still active in your account with the provider. Then paste it again.",
      busy: false,
    };
  }
  return {
    tone: "warning",
    headline: "Could not reach the provider",
    reason: check.reason,
    hint: "This does not say the key is wrong. Try Check again in a moment.",
    busy: false,
  };
}

export type CapabilityView = { tone: ConnectorTone; words: string };

/**
 * What the strip at the top may claim for one capability.
 *
 * "On" needs a key that a provider answered to. Anything less says so: a key
 * that was refused, a provider nobody could reach, a key nobody has checked,
 * and no key at all are four different sentences, and none of them is "on".
 *
 * There is no in-flight state here. A probe is owned by the row that started
 * it and the row says "Checking…" while it runs (see connectorStatus); the
 * strip is a summary of settled answers. A `checking` parameter used to sit
 * here that no caller ever passed, which made the branch unreachable and the
 * strip's contract a claim rather than a fact.
 */
export function capabilityStatus(
  members: Connector[],
  checks: Record<string, ConnectorCheck>,
): CapabilityView {
  if (members.length === 0) return { tone: "muted", words: "not offered" };
  const verdicts = members.map((member) => checks[member.id]?.verdict);
  if (verdicts.some((verdict) => verdict === "works")) {
    return { tone: "success", words: "on" };
  }
  if (!members.some((member) => member.configured)) {
    return { tone: "muted", words: "no key" };
  }
  if (verdicts.some((verdict) => verdict === "rejected")) {
    return { tone: "danger", words: "key refused" };
  }
  if (verdicts.some((verdict) => verdict === "unreachable")) {
    return { tone: "warning", words: "provider not reachable" };
  }
  return { tone: "accent", words: "key saved, not checked yet" };
}

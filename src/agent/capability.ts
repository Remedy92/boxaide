/**
 * What one agent CLI can do on this machine, and why not when it cannot.
 *
 * One function answers every "can it chat / can it run / is it isolated"
 * question: the listing the UI draws its pickers from, the chat launch, and
 * the run resolver. They used to answer it three times, in three places, with
 * three slightly different rules, and the UI could only say "greyed out".
 *
 * A reason is a sentence for a person. It reaches the user unedited, so it
 * says what is wrong and, where there is one, the fix.
 */
import { resolveAccess } from "./sandbox.js";
import type { AgentSpec, LaunchContext } from "./spec.js";

/** `reason` is null exactly when `ok` is true. */
export type AgentCheck = { ok: boolean; reason: string | null };

export type AgentCapability = {
  /** The binary was found on PATH (or in a well known bin dir). */
  installed: boolean;
  /** Can carry the watched chat loop. */
  chat: AgentCheck;
  /** Can carry an unattended automation run. */
  runs: AgentCheck;
  /** Whether Boxaide really keeps this CLI off the user's own config, and how. */
  isolation: { isolated: boolean; note: string };
};

/** The one place `ok` is decided, so it can never disagree with `reason`. */
function check(reason: string | null): AgentCheck {
  return { ok: reason === null, reason };
}

export function capabilityOf(
  spec: AgentSpec,
  bin: string | null,
  ctx: LaunchContext,
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
): AgentCapability {
  // Isolation first, because `runs` depends on it. Keyed on the access
  // decision rather than on the platform: `BOXAIDE_AGENT_ACCESS=full` builds
  // no profile at all, so a platform check would report a deny that was never
  // emitted.
  const decided = resolveAccess(ctx.access ?? "workspace", platform);
  const confined = decided.access !== "full";
  const declared = spec.isolation?.(env, confined) ?? {
    isolated: false,
    note: `Boxaide does not isolate ${spec.label} from your own config.`,
  };
  const isolation = confined
    ? declared
    : {
        isolated: declared.isolated,
        // The notice names the machine this install is really on. Reused
        // verbatim so the picker and RunningAgent.accessNotice agree.
        note: `${decided.notice} ${declared.note}`,
      };

  const missing = `${spec.label} is not installed (no ${spec.bin} on PATH)`;

  // Once, not once per check: a preflight reads the user's config off disk,
  // and list() answers this for every agent on every poll.
  const blocked = bin === null ? null : (spec.preflight?.(ctx, env) ?? null);

  const chat = check(
    spec.args === undefined && spec.drive === undefined
      ? `${spec.label} cannot be launched yet`
      : bin === null
        ? missing
        : blocked,
  );

  // The preflight asks whether the user's own global config reaches into the
  // launch, and isolation is the thing that stops it reaching. An isolated
  // run provably cannot open that file, so refusing the run over an entry
  // inside it would refuse every schedule forever with a remediation about a
  // file the run cannot read. Degraded isolation is the case where the entry
  // really does load, and there the refusal is correct.
  const runs = check(
    spec.runArgs === undefined
      ? `${spec.label} cannot run automations yet`
      : bin === null
        ? missing
        : isolation.isolated
          ? null
          : blocked,
  );

  return { installed: bin !== null, chat, runs, isolation };
}

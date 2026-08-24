/**
 * Driving Antigravity (agy) from inside Boxaide: one short-lived process per
 * turn.
 *
 * The launch this replaces was a single `agy -p KICKOFF`, with the loop inside
 * the model. It ended the way Claude Code's did, and then one way of its own:
 * `agy --print-timeout` defaults to 5m0s, and a model parked in
 * `chat_await_message` waiting for the user to type is exactly what that
 * timeout measures. So the process exited 1, with an empty stderr and nothing
 * to restart it, and the pane sat on "Waiting for an agent" for the rest of the
 * session. Verified: `agy -p … --print-timeout 2s` exits 1, writes nothing to
 * stderr, and its last stdout line is
 * `{"event":"result","result":{"status":"ERROR","response":"","error":"timeout
 * waiting for response", …}}`.
 *
 * A driven turn cannot hit that: the process lives for one message, and the
 * timeout it is given is the one this file sets. Everything else about the
 * shape, the spawn, the two deadlines, the kill paths, the per-chat session
 * bookkeeping, is TurnDriver's, shared with Claude Code.
 *
 * Two things are agy's alone and are why this file exists at all:
 *
 * The conversation id. agy reports it on `init` before the model has done
 * anything, and `--conversation <id>` resumes it. An id it cannot find is a
 * warning on stderr and a NEW conversation, not a failure, verified: the run
 * answered normally, and its `init` line carried a different id from the one
 * asked for. So there is nothing to detect and nothing to clear: the reader
 * takes whatever id the run reports and `takeTurn` saves that, which is already
 * the new one.
 *
 * The framing. agy has no --append-system-prompt and no other way to put a
 * system prompt on a print-mode run, so DRIVEN_SYSTEM rides at the head of the
 * prompt itself (see `antigravityTurnArgs`). It goes on every turn rather than
 * only the first, because a silently rotated conversation would otherwise be
 * the one turn that never got told what it is answering.
 */
import { agyTurnReader } from "./agent-stream.js";
import {
  TurnDriver,
  type TurnDriverOptions,
  type TurnOutcome,
} from "./turn-driver.js";

/**
 * The timeout agy is given for one turn, and the deadline this driver enforces
 * behind it.
 *
 * Two numbers rather than one, and in that order on purpose. agy's own timeout
 * fires first and ends the turn the tidy way: a result event naming the reason,
 * a clean exit, and a transcript the next turn can still resume. The driver's
 * deadline is a minute later and only exists for a child that ignored its own —
 * it is a SIGKILL, which loses whatever the CLI had not written down yet.
 *
 * Fifteen minutes because a real inbox turn can be minutes of tool calls and a
 * cap that cuts those off would be a worse bug than the one this fixes. The
 * silence watchdog (WATCHDOG_MS, 3 minutes) is what catches an ordinary stall;
 * this is only for a turn that keeps talking and never finishes.
 */
export const AGY_PRINT_TIMEOUT_MS = 900_000;
export const AGY_TURN_DEADLINE_MS = AGY_PRINT_TIMEOUT_MS + 60_000;

/** `--print-timeout` takes a Go duration. Seconds, so it stays readable. */
export function agyPrintTimeoutArg(ms = AGY_PRINT_TIMEOUT_MS): string {
  return `${Math.round(ms / 1000)}s`;
}

export class AgyDriver extends TurnDriver {
  protected readonly cli = "agy";

  constructor(opts: TurnDriverOptions) {
    super({ turnTimeoutMs: AGY_TURN_DEADLINE_MS, ...opts });
  }

  protected reader(outcome: TurnOutcome, onLine: (tool: string | null) => void) {
    return agyTurnReader(outcome, onLine);
  }

  // No `resumeRefused`: agy answers an unknown --conversation by starting a new
  // one and reporting the new id, so the base's "never" is the truth here.
  // Clearing the stored session on some other error would only cost a working
  // chat its memory.
  //
  // No `prompt` override either: agy keeps its sign-in in ~/.gemini, which the
  // launch cannot move and does not copy, so there is no stale credential to
  // repair. A signed-out agy fails its turns like any other broken CLI and the
  // loop reports that after MAX_DELIVERIES, with the CLI's own words.
}

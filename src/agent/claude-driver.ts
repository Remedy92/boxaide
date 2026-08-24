/**
 * Driving Claude Code from inside Boxaide: one short-lived process per turn.
 *
 * The old launch was a single `claude -p KICKOFF`, and the loop lived in that
 * prompt. So the loop lasted exactly as long as the model kept choosing to call
 * `chat_await_message`: it could decide it was finished, an MCP poll could time
 * out at the wrong moment, and the pane went back to "Waiting for an agent"
 * mid-conversation with nothing wrong and nothing to restart.
 *
 * Boxaide holds the loop instead, the same way it does for OpenCode. OpenCode
 * has a server to prompt; Claude Code has no server mode at all, so the unit of
 * work is a process: one `claude -p <user message>` per user turn, and the
 * conversation is carried across those processes by `--resume <session id>`.
 * The CLI reports that id on every stream-json line and the final `result`
 * event carries the answer, both verified against claude 2.1.233.
 *
 * A process per turn is not a workaround, it is the honest shape of the CLI. It
 * also removes the failure mode this replaces: there is nothing long-lived left
 * to quit early. A turn either produces a result event or it fails, and a
 * failure gives the lease back so the message is handed over again.
 *
 * That whole shape lives in turn-driver.ts and is shared with Antigravity. What
 * is left here is what is Claude Code's alone: its stream-json wire format, the
 * "No conversation found" refusal, and the one silent credential repair a
 * signed-out launch is allowed to cost.
 */
import {
  claudeAuthFailed,
  claudeTurnReader,
  CLAUDE_EMPTY_SUCCESS,
  type StreamTurnOutcome,
} from "./agent-stream.js";
import type { StopCause } from "./driver.js";
import {
  TurnDriver,
  type TurnDriverOptions,
  type TurnOutcome,
  type TurnRequest,
} from "./turn-driver.js";

/** What the launcher must fill in to turn one user message into a command line. */
export type ClaudeTurnRequest = TurnRequest;

export type ClaudeDriverOptions = TurnDriverOptions & {
  /**
   * Repairs this launch's copied credential and says whether anything changed.
   *
   * The driver knows a turn failed for authentication; it does not know where
   * the launch keeps its isolated home, and it must not: the launcher owns
   * every path a launch touches. So the repair itself is passed in, and all
   * this file decides is when one is worth spending. False means nothing moved,
   * which is the launcher saying a retry would fail identically.
   */
  healAuth?: () => boolean;
  onStop?: (error: string | null, cause: StopCause) => void;
};

export class ClaudeDriver extends TurnDriver {
  protected readonly cli = "claude";
  /**
   * The one silent credential repair this run gets.
   *
   * Once, because the repair's whole premise is that the copied credential went
   * stale while the machine's own login is fine. If a turn is still signed out
   * after a fresh copy, the user is signed out — and retrying the repair every
   * turn would spend the whole delivery budget re-copying a file that is not
   * the problem, then report a timeout instead of the sign-out.
   */
  private healed = false;

  constructor(protected override opts: ClaudeDriverOptions) {
    // No turnTimeoutMs. The silence watchdog is what ends a claude turn that
    // stalls; a cap on one that keeps talking would cut off long real work
    // mid-tool-call, which for this CLI is ordinary and not a symptom. The
    // known cost: past the channel's half-hour lease ceiling the pane says the
    // message was never answered while an answer may still arrive late, and
    // nothing here unwedges the loop until that child finishes or dies on its
    // own. See turnTimeoutMs in turn-driver.ts.
    super(opts);
  }

  protected reader(outcome: TurnOutcome, onLine: (tool: string | null) => void) {
    return claudeTurnReader(outcome, onLine);
  }

  /**
   * Whether a failure is the CLI refusing the session we asked it to resume.
   *
   * Matched on the id appearing in the message, "No conversation found with
   * session ID: <uuid>", verified, with the phrase as a second reading in case a
   * later CLI stops echoing the id. Deliberately narrow: a broad match would
   * throw away a working session's context on any error that said "session".
   */
  protected override resumeRefused(message: string | null, sessionId: string): boolean {
    if (!message) return false;
    return message.includes(sessionId) || /no conversation found/i.test(message);
  }

  /**
   * One turn of one chat, plus the one repair a signed-out CLI is allowed to
   * cost.
   *
   * The launch copies the user's credential into an isolated home, and on macOS
   * the real login usually lives in the keychain — so that copy can be a stale
   * file shadowing a perfectly good sign-in, and every turn of the run then
   * reports "Not logged in" until the message is dropped. The repair deletes
   * the copy and takes a fresh one, which costs a few milliseconds and fixes
   * the whole class silently. Anything still signed out after that is a real
   * sign-out, and the user has to be told rather than retried at.
   *
   * Throws on any failure, including this one: an unanswerable turn gives the
   * lease back, which is what puts the message in front of the next attempt.
   */
  protected override async prompt(chatId: string, text: string): Promise<string> {
    let outcome = await this.takeTurn(chatId, text);
    if (claudeAuthFailed(outcome)) {
      if (!this.healed) {
        this.healed = true;
        // A repair that moved nothing means the retry would meet the same
        // credential, so it is not worth a second process.
        if (this.opts.healAuth?.()) outcome = await this.takeTurn(chatId, text);
      }
      if (claudeAuthFailed(outcome)) {
        this.authRequired = true;
        throw new Error(signedOutMessage(outcome));
      }
    }
    if (outcome.text) return outcome.text;
    // An empty answer is a failed turn. Posting nothing would end the lease with
    // a blank reply in the pane; throwing re-queues the message instead.
    throw new Error(outcome.error ?? "claude produced no answer");
  }
}

/**
 * What the pane is told when the CLI has no sign-in.
 *
 * The CLI's own words when it wrote any: they name the account and the command,
 * which is more than this file knows. The empty-success case wrote nothing a
 * person could act on, so it states the conclusion instead of repeating
 * "claude: success" at somebody who is trying to find out why their agent
 * stopped answering.
 */
function signedOutMessage(outcome: StreamTurnOutcome): string {
  const said = (outcome.text ?? outcome.error ?? "").trim();
  // No `claude /login` instruction here: on macOS a login run in the user's
  // own terminal lands in a keychain slot the launch cannot see, and telling
  // them to do that is what kept the sign-out loop turning. The Sign in
  // button runs the login against the launch's own home.
  if (!said || said === CLAUDE_EMPTY_SUCCESS) {
    return "claude is not signed in: use the Sign in button";
  }
  return `claude is not signed in: ${said}`;
}

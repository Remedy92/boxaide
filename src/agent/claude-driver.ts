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
 * The one thing that can be lost is memory. If a resume is refused — a pruned
 * transcript, a different home directory — the driver drops the session id and
 * starts a fresh one rather than failing the turn: an amnesiac agent beats a
 * dead one, and the user's next message still gets answered.
 *
 * The loop's own chat tools are absent from a driven session's allowlist (see
 * `drivenPreapprovedToolNames` in launcher.ts). Two askers on one channel is
 * the double-answer hole the lease exists to close, and a sentence in a prompt
 * is not a gate. `chat_history` stays: it touches no lease, and it is how a
 * session that lost its transcript reads back what was already said.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { claudeTurnReader, type ClaudeTurnOutcome } from "./agent-stream.js";
import {
  DRIVEN_SYSTEM,
  runDrivenLoop,
  TITLE_PROMPT,
  watchdogTickMs,
  WATCHDOG_MS,
  type AgentDriver,
  type DriverChannel,
} from "./driver.js";
import { MAX_DELIVERIES } from "../db/store.js";

/**
 * Consecutive failed turns before the loop gives up and reports an exit.
 *
 * The OpenCode driver retries forever, because a server that is down may come
 * back and the child process is still visibly running behind it. Here the child
 * IS the turn: processes in a row that cannot produce an answer mean the CLI
 * cannot run at all — not logged in, no quota, a bad model id — and the user
 * needs to be told that instead of watching a spinner.
 *
 * It is MAX_DELIVERIES and not a number of its own, because a failed turn gives
 * the lease back and that burns a delivery. A cap above the delivery cap is
 * unreachable for a single queued message: the channel dead-letters it first and
 * the loop then waits forever on a queue it just emptied, which looks exactly
 * like a healthy agent answering nothing.
 */
const MAX_FAILURES = MAX_DELIVERIES;

/** Bytes of a failed turn's stderr carried into the exit the user is shown. */
const STDERR_TAIL_LIMIT = 2_048;

/**
 * How long a turn's child gets to exit on SIGTERM before it is killed.
 *
 * Stop asks politely first, because the CLI writes the rest of this turn's
 * transcript on the way out and that is what the next launch resumes from. But
 * the watchdog only fires on silence, so a child that ignores SIGTERM while
 * still printing would hold the loop — and therefore the launcher's `running` —
 * until Boxaide itself restarted.
 */
const STOP_GRACE_MS = 5_000;

/** What the launcher must fill in to turn one user message into a command line. */
export type ClaudeTurnRequest = {
  /** The user's message, verbatim. It is the whole prompt. */
  prompt: string;
  /** Framing for `--append-system-prompt`. */
  system: string;
  /** The session to continue, or null to start one. */
  sessionId: string | null;
};

export type ClaudeDriverOptions = {
  channel: DriverChannel;
  /** Client name every turn is stamped with. The registry id, "claude-code". */
  agent: string;
  /** Absolute path of the resolved `claude` binary. */
  bin: string;
  /**
   * argv for one turn. Owned by the launcher so that every flag Boxaide passes
   * to a CLI — MCP config, allowlist, model — stays in the one file that is
   * responsible for those decisions.
   */
  argsFor: (turn: ClaudeTurnRequest) => string[];
  /** The isolated agent workdir, as the child's cwd. */
  cwd: string;
  /** The full child environment, exactly as a launcher spawn would build it. */
  env: NodeJS.ProcessEnv;
  /**
   * The loop's end: null when it was stopped, a message when it gave up. The
   * launcher has no child exit to watch for a driven agent, so this is the only
   * exit there is.
   */
  onStop?: (error: string | null) => void;
  /** Overridable for tests. */
  waitMs?: number;
  retryBaseMs?: number;
  watchdogMs?: number;
  maxFailures?: number;
  stopGraceMs?: number;
};

export class ClaudeDriver implements AgentDriver {
  private abort = new AbortController();
  private stopped = false;
  /** The session the next turn resumes. Null starts a fresh one. */
  private sessionId: string | null = null;
  /** The turn's process, so stop() and the watchdog can end it. */
  private child: ChildProcess | null = null;
  /** Why the loop gave up, reported once through onStop. */
  private giveUp: string | null = null;
  /** The naming call for the last answered turn, while it is still running. */
  private naming: Promise<void> | null = null;
  /** Resolves when the loop has left `run`. Tests await it; production does not. */
  readonly done: Promise<void>;
  private release!: () => void;

  constructor(private opts: ClaudeDriverOptions) {
    this.done = new Promise<void>((resolve) => (this.release = resolve));
  }

  /** Starts the loop. Returns immediately; failures live inside the loop. */
  start(): this {
    this.opts.channel.setDriven(true);
    void this.run()
      .catch((err) => {
        // runDrivenLoop turns everything the loop can meet into a reason, so
        // this is a bug in the driver itself. It still must not reject: nothing
        // above awaits this, and an unhandled rejection ends the process.
        this.giveUp ??= err instanceof Error ? err.message : String(err);
      })
      .then(() => this.finish());
    return this;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // The turn in flight is ended by the abort listener runTurn registers, which
    // escalates SIGTERM to SIGKILL on its own.
    this.abort.abort();
  }

  /** Runs once, however the loop ended. */
  private finish(): void {
    // The chat tools go back to the MCP tier.
    this.opts.channel.setDriven(false);
    try {
      this.opts.onStop?.(this.giveUp);
    } catch {
      // The launcher's own bookkeeping, which at shutdown reads a store that may
      // already be closed. The loop is over either way, and a throw here would
      // otherwise take the process down with it.
    }
    this.release();
  }

  private async run(): Promise<void> {
    this.giveUp = await runDrivenLoop(
      {
        channel: this.opts.channel,
        agent: this.opts.agent,
        signal: this.abort.signal,
        stopped: () => this.stopped,
        waitMs: this.opts.waitMs,
        retryBaseMs: this.opts.retryBaseMs,
        maxFailures: this.opts.maxFailures ?? MAX_FAILURES,
        beforeTurn: () => this.naming ?? Promise.resolve(),
        afterReply: (chatId) => {
          this.naming = this.maybeName(chatId).finally(() => {
            this.naming = null;
          });
        },
      },
      (text) => this.prompt(text),
    );
  }

  /**
   * Names the chat, once, from the exchange that just happened.
   *
   * A driven session has no chat tools to pass a title through `chat_say`, so
   * the name is asked for on the same session. Best effort: a failed or refused
   * title leaves the first-line guess in place and never reaches the retry path.
   */
  private async maybeName(chatId: string): Promise<void> {
    try {
      if (this.stopped) return;
      if (!this.opts.channel.needsTitle(chatId)) return;
      const raw = await this.prompt(TITLE_PROMPT);
      this.opts.channel.nameChat(chatId, raw);
    } catch {
      // No name is a fine outcome. The answer is already posted.
    }
  }

  /** One turn: spawn, read, answer. Throws on any failure. */
  private async prompt(text: string): Promise<string> {
    const resuming = this.sessionId;
    const outcome = await this.runTurn({
      prompt: text,
      system: DRIVEN_SYSTEM,
      sessionId: resuming,
    });
    // The id is taken from a failed turn too: a fresh session that failed
    // mid-work still exists, and resuming it is how the retry keeps whatever
    // the model already did.
    if (outcome.sessionId) this.sessionId = outcome.sessionId;
    if (outcome.text) return outcome.text;
    // A resume the CLI could not find will never be found: the transcript is
    // gone. Keeping the id would fail every later turn the same way, so drop it
    // and let the retry start a session — losing context, not the conversation.
    if (resuming && resumeRefused(outcome.error, resuming)) this.sessionId = null;
    // An empty answer is a failed turn. Posting nothing would end the lease with
    // a blank reply in the pane; throwing re-queues the message instead.
    throw new Error(outcome.error ?? "claude produced no answer");
  }

  /**
   * One `claude -p` process, read to completion.
   *
   * Never rejects: everything a turn can produce — an answer, an error, a
   * killed child — is an outcome the caller decides about. The only thing this
   * owes the channel is that every stdout line is reported, whether or not it
   * carries a tool name, because that is what keeps the pane's presence alive
   * while the model does work Boxaide never sees.
   */
  private runTurn(turn: ClaudeTurnRequest): Promise<ClaudeTurnOutcome> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.opts.bin, this.opts.argsFor(turn), {
          cwd: this.opts.cwd,
          env: this.opts.env,
          // stdout is the whole protocol here, and MUST be consumed: a pipe
          // nobody reads fills its buffer and blocks the child mid-write.
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        // A bad binary path throws synchronously; ENOENT arrives as "error".
        return resolve({
          text: null,
          sessionId: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.child = child;

      const found: ClaudeTurnOutcome = { text: null, sessionId: null, error: null };
      let stderr = "";
      let killed = false;
      let lastLine = Date.now();

      const watchdogMs = this.opts.watchdogMs ?? WATCHDOG_MS;
      const watchdog = setInterval(() => {
        if (Date.now() - lastLine < watchdogMs) return;
        killed = true;
        // SIGKILL: the deadline has already passed, and a CLI that ignores a
        // polite signal would hold the lease for the rest of the session.
        child.kill("SIGKILL");
      }, watchdogTickMs(watchdogMs));

      const onStop = () => this.endChild(child);
      // An abort that landed in the gap between spawn and here never fires the
      // listener, and would leave this child running for the whole turn.
      if (this.abort.signal.aborted) onStop();
      else this.abort.signal.addEventListener("abort", onStop, { once: true });

      // One parse per line, feeding both the pane and this turn's outcome.
      const feed = claudeTurnReader(found, (tool) => {
        lastLine = Date.now();
        // Every line is liveness; only some carry a tool name.
        this.opts.channel.noteAgentActivity(tool);
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", feed);
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_LIMIT);
      });

      const finish = (code: number | null, spawnError?: Error) => {
        clearInterval(watchdog);
        this.abort.signal.removeEventListener("abort", onStop);
        if (this.child === child) this.child = null;
        // Whatever arrived without a closing newline is still a line, and for a
        // turn read for its result event it may be the only one that matters.
        feed.flush();
        if (found.text) {
          return resolve({ text: found.text, sessionId: found.sessionId, error: null });
        }
        resolve({
          text: null,
          sessionId: found.sessionId,
          error: turnError({ code, killed, watchdogMs, spawnError, stderr, found }),
        });
      };
      // Spawn failures (ENOENT, EACCES) surface here and never reach "close".
      child.on("error", (err) => finish(null, err));
      // "close", not "exit": exit fires while stdout may still hold undrained
      // data, and the last thing written is the result event.
      child.on("close", (code) => finish(code));
    });
  }

  /**
   * Ends a turn's child: SIGTERM, then SIGKILL if it is still there.
   *
   * The polite signal first, because the CLI writes the rest of the transcript
   * on the way out. The escalation is not the watchdog's job — that one only
   * fires on silence, so a child that ignores SIGTERM while still printing would
   * never be killed, and the loop it holds is the launcher's `running`.
   */
  private endChild(child: ChildProcess): void {
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, this.opts.stopGraceMs ?? STOP_GRACE_MS);
    // A grace timer must not be what keeps the process alive at shutdown.
    timer.unref?.();
    child.once("close", () => clearTimeout(timer));
  }
}

/** Why a turn that produced no answer failed, in one line fit for the pane. */
function turnError(ctx: {
  code: number | null;
  killed: boolean;
  watchdogMs: number;
  spawnError?: Error;
  stderr: string;
  found: ClaudeTurnOutcome;
}): string {
  if (ctx.spawnError) return ctx.spawnError.message;
  if (ctx.killed) {
    return `claude went quiet for ${Math.round(ctx.watchdogMs / 1000)}s and was stopped`;
  }
  // The CLI's own error text first: it names the cause, where an exit code only
  // says there was one.
  const reported = ctx.found.error ?? ctx.stderr.trim().split("\n").pop() ?? "";
  if (reported) return reported;
  return `claude exited ${ctx.code ?? "on a signal"} without an answer`;
}

/**
 * Whether a failure is the CLI refusing the session we asked it to resume.
 *
 * Matched on the id appearing in the message — "No conversation found with
 * session ID: <uuid>", verified — with the phrase as a second reading in case a
 * later CLI stops echoing the id. Deliberately narrow: a broad match would
 * throw away a working session's context on any error that said "session".
 */
function resumeRefused(message: string | null, sessionId: string): boolean {
  if (!message) return false;
  return message.includes(sessionId) || /no conversation found/i.test(message);
}

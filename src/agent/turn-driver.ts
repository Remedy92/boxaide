/**
 * The process-per-turn driver, for every CLI whose loop must not live in a
 * prompt.
 *
 * Two CLIs are driven this way, Claude Code and Antigravity, and they failed
 * the same way before they were: one long-lived `-p KICKOFF` child, the loop
 * inside the model, and a pane stuck on "Waiting for an agent" the moment that
 * child decided it was finished. So Boxaide holds the loop (driver.ts,
 * `runDrivenLoop`) and the unit of work is a process: one `<cli> -p <message>`
 * per user turn, with the conversation carried across those processes by the
 * CLI's own resume flag.
 *
 * Everything in that shape is the same for both: the spawn, the two deadlines,
 * the SIGTERM-then-SIGKILL, the per-chat session bookkeeping, the naming call,
 * and what Stop is allowed to kill. What differs is only the wire format and
 * the wording of a failure, and those are what a subclass supplies. Written as
 * one class rather than two so the lease protocol and the kill paths, the
 * parts that strand a turn when they drift, cannot drift.
 *
 * One session per chat, not per agent: a single running agent answers every
 * chat, and one shared session would feed every conversation into the same
 * transcript. The ids live beside the chats in the store, so an agent that is
 * stopped and started again resumes where each conversation left off.
 *
 * The one thing that can be lost is memory. If a resume is refused, a pruned
 * transcript, a different home directory, the driver drops that chat's session
 * id and starts a fresh one rather than failing the turn: an amnesiac agent
 * beats a dead one, and the user's next message still gets answered.
 *
 * The loop's own chat tools are absent from a driven session's allowlist (see
 * `drivenPreapprovedToolNames` in spec.ts). Two askers on one channel is the
 * double-answer hole the lease exists to close, and a sentence in a prompt is
 * not a gate. `chat_history` stays: it touches no lease, and it is how a session
 * that lost its transcript reads back what was already said.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { LineFeed, StreamTurnOutcome } from "./agent-stream.js";
import {
  drivenSystemWithMemory,
  runDrivenLoop,
  STOPPED_BY_USER,
  TITLE_PROMPT,
  watchdogTickMs,
  WATCHDOG_MS,
  type AgentDriver,
  type DriverChannel,
  type StopCause,
} from "./driver.js";
import { MAX_DELIVERIES } from "../db/store.js";
import { logError, logInfo } from "../log.js";

/**
 * Consecutive failed turns before the loop gives up and reports an exit.
 *
 * The OpenCode driver retries forever, because a server that is down may come
 * back and the child process is still visibly running behind it. Here the child
 * IS the turn: processes in a row that cannot produce an answer mean the CLI
 * cannot run at all, not logged in, no quota, a bad model id, and the user
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
 * still printing would hold the loop, and therefore the launcher's `running` , 
 * until Boxaide itself restarted.
 */
const STOP_GRACE_MS = 5_000;

/** What the launcher must fill in to turn one user message into a command line. */
export type TurnRequest = {
  /** The user's message, verbatim. It is the whole prompt. */
  prompt: string;
  /**
   * Framing for the turn: what the model is told about the conversation it is
   * in. How it reaches the CLI is the CLI module's business, a system-prompt
   * flag where there is one, the head of the prompt where there is not.
   */
  system: string;
  /** The session to continue, or null to start one. */
  sessionId: string | null;
};

/**
 * What one turn's process produced, folded together line by line. Declared with
 * the readers in agent-stream.ts, because that is what fills it in.
 */
export type TurnOutcome = StreamTurnOutcome;

/** Why a turn's child ended early, when this driver ended it. */
export type TurnKill =
  /** Nothing on stdout for the whole silence window. */
  | "silence"
  /** Still talking, but past the absolute deadline for one turn. */
  | "deadline";

/** Everything a subclass needs to explain a turn that produced no answer. */
export type TurnFailure = {
  code: number | null;
  /** Null when the child ended on its own. */
  killed: TurnKill | null;
  watchdogMs: number;
  turnTimeoutMs: number | null;
  spawnError?: Error;
  stderr: string;
  found: TurnOutcome;
};

export type TurnDriverOptions = {
  channel: DriverChannel;
  /** Client name every turn is stamped with. The registry id. */
  agent: string;
  /** Absolute path of the resolved CLI binary. */
  bin: string;
  /**
   * argv for one turn. Owned by the launcher so that every flag Boxaide passes
   * to a CLI, MCP config, allowlist, model, stays in the one file that is
   * responsible for those decisions.
   */
  argsFor: (turn: TurnRequest) => string[];
  /** The isolated agent workdir, as the child's cwd. */
  cwd: string;
  /** The full child environment, exactly as a launcher spawn would build it. */
  env: NodeJS.ProcessEnv;
  /**
   * The workspace-memory block for this install, appended to DRIVEN_SYSTEM on
   * every turn. A function, not a string: a session outlives the notes it
   * started with, and an agent that has just written its first ones must not
   * spend the rest of the session being told it has none and offering again.
   * The launcher supplies the read (sync, one small file), so this driver
   * still touches no filesystem itself. Absent means none, which is what
   * tests construct.
   */
  memorySystem?: () => string;
  /**
   * The loop's end: null when it was stopped, a message when it gave up. The
   * launcher has no child exit to watch for a driven agent, so this is the only
   * exit there is. The cause carries what the pane cannot read off that message
   *, today, whether the CLI is signed out.
   */
  onStop?: (error: string | null, cause: StopCause) => void;
  /** Overridable for tests. */
  waitMs?: number;
  retryBaseMs?: number;
  watchdogMs?: number;
  /**
   * The longest one turn may take, however talkative it is.
   *
   * Silence alone does not catch every stuck turn: a CLI that keeps narrating
   * while it gets nowhere is live by the watchdog's reading and still never
   * finishes, and the lease it holds is the pane's whole conversation. Absent
   * means no absolute deadline, which is what a CLI with a timeout of its own
   * wants.
   */
  turnTimeoutMs?: number;
  maxFailures?: number;
  stopGraceMs?: number;
};

export abstract class TurnDriver implements AgentDriver {
  private abort = new AbortController();
  protected stopped = false;
  /** The turn's process, so stop() and the watchdog can end it. */
  private child: ChildProcess | null = null;
  /** Why the loop gave up, reported once through onStop. */
  private giveUp: string | null = null;
  /**
   * A turn ended on a sign-in failure that no repair fixed. Sticky for the rest
   * of the run: it is what the exit record is stamped with, and by the time the
   * loop gives up the failing turn is several backoffs behind.
   */
  protected authRequired = false;
  /** The naming call for the last answered turn, while it is still running. */
  private naming: Promise<void> | null = null;
  /**
   * The user turn being prompted for, while one is. Null covers the naming
   * calls and the gaps between turns, which Stop must never mistake for the
   * message it was pressed on.
   */
  private runningSeq: number | null = null;
  /** A user turn the user stopped. Never handed to the model. */
  private cancelledSeq: number | null = null;
  /**
   * The chat the running process belongs to, for the log only.
   *
   * A turn's child is spawned from `runTurn`, which is handed a prompt and a
   * session and deliberately knows nothing about chats. An id is what makes a
   * line on disk traceable back to the conversation that stalled, so it is
   * carried here rather than pushed into the request the argv is built from.
   */
  private loggedChat: string | null = null;
  /** Resolves when the loop has left `run`. Tests await it; production does not. */
  readonly done: Promise<void>;
  private release!: () => void;

  constructor(protected opts: TurnDriverOptions) {
    this.done = new Promise<void>((resolve) => (this.release = resolve));
  }

  /**
   * The CLI's name as a person reads it, for the sentences a failed turn
   * produces. The binary's name, not the agent id: "agy went quiet" is what the
   * user would type to reproduce it.
   */
  protected abstract readonly cli: string;

  /**
   * This CLI's stream, for one turn.
   *
   * `onLine` runs for every line, with the tool it named or null: the driver
   * owns both liveness and the presence label, and the reader owns the wire
   * format.
   */
  protected abstract reader(
    outcome: TurnOutcome,
    onLine: (tool: string | null) => void,
  ): LineFeed;

  /**
   * Whether a failure is the CLI refusing the session it was asked to resume.
   *
   * Default no, for a CLI that answers an unknown session by starting a fresh
   * one: there the id it reports is already the new one, and dropping the
   * stored session would only lose a working chat's context on some unrelated
   * error.
   */
  protected resumeRefused(_error: string | null, _sessionId: string): boolean {
    return false;
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

  /**
   * Ends the turn `seq` belongs to, and only that.
   *
   * The driver's own signal is left alone: aborting it would end the loop as
   * well, and Stop is meant to leave the agent up for the next message. Killing
   * the child makes the turn fail, and the loop's failure path hands the message
   * back, where the channel has already answered it, so it is not re-delivered
   * and the failure is not counted.
   *
   * The child is killed only when it belongs to this seq. A turn that has been
   * claimed but not yet prompted for has no child of its own, and the one that
   * is running then is the previous chat's naming call, killing that would
   * cost a chat its name and leave the stopped question to be asked anyway.
   * Recording the seq is what stops it: `takeTurn` refuses to spawn for it.
   */
  interrupt(seq: number): boolean {
    if (this.stopped) return false;
    // So a failed turn a moment later reads as a Stop somebody pressed rather
    // than a CLI that died on its own.
    logInfo("agent.turn", "interrupt", {
      agent: this.opts.agent,
      chat: this.loggedChat,
      seq,
      running: this.runningSeq === seq,
    });
    this.cancelledSeq = seq;
    if (this.runningSeq === seq && this.child) this.endChild(this.child);
    return true;
  }

  /** Whether `seq` is a turn Stop has already closed. Null is never one. */
  private isCancelled(seq: number | null): boolean {
    return seq !== null && this.cancelledSeq === seq;
  }

  /** Runs once, however the loop ended. */
  private finish(): void {
    // The chat tools go back to the MCP tier.
    this.opts.channel.setDriven(false);
    try {
      this.opts.onStop?.(this.giveUp, { authRequired: this.authRequired });
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
      (turn) => {
        this.runningSeq = turn.seq;
        return this.prompt(turn.chatId, turn.text).finally(() => {
          this.runningSeq = null;
        });
      },
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
      const raw = await this.prompt(chatId, TITLE_PROMPT);
      this.opts.channel.nameChat(chatId, raw);
    } catch {
      // No name is a fine outcome. The answer is already posted.
    }
  }

  /**
   * One turn of one chat, as an answer or a throw.
   *
   * Throws on any failure: an unanswerable turn gives the lease back, which is
   * what puts the message in front of the next attempt. Overridden by a driver
   * whose CLI has a failure worth one silent repair before it counts.
   */
  protected async prompt(chatId: string, text: string): Promise<string> {
    const outcome = await this.takeTurn(chatId, text);
    if (outcome.text) return outcome.text;
    // An empty answer is a failed turn. Posting nothing would end the lease with
    // a blank reply in the pane; throwing re-queues the message instead.
    throw new Error(outcome.error ?? `${this.cli} produced no answer`);
  }

  /**
   * One CLI process, with the session bookkeeping its outcome implies.
   *
   * The session is looked up per chat rather than held for the driver. One
   * running agent answers every chat, and a shared session would pour every
   * conversation into a single transcript, each chat asking the model to
   * continue whatever some other chat was talking about.
   */
  protected async takeTurn(chatId: string, text: string): Promise<TurnOutcome> {
    // Stopped before this process was spawned: while the loop was finishing the
    // previous chat's naming call, or in the gap a repair retry opens. Either
    // way the question is already answered, and asking it would answer it twice.
    if (this.isCancelled(this.runningSeq)) {
      return { text: null, sessionId: null, error: STOPPED_BY_USER };
    }
    this.loggedChat = chatId;
    const { id: resuming, epoch } = this.opts.channel.chatSession(
      chatId,
      this.opts.agent,
    );
    const outcome = await this.runTurn({
      prompt: text,
      system: drivenSystemWithMemory(this.opts.memorySystem?.()),
      sessionId: resuming,
    });
    // The id is taken from a failed turn too: a fresh session that failed
    // mid-work still exists, and resuming it is how the retry keeps whatever
    // the model already did. It is also how a CLI that answered an unknown
    // resume by starting a new conversation gets that new id remembered.
    //
    // Handed back with the epoch this turn started on, so a chat the user
    // cleared while the model was working stays cleared: the save is refused
    // rather than resurrecting the transcript they just emptied.
    if (outcome.sessionId) {
      this.opts.channel.saveChatSession(
        chatId,
        this.opts.agent,
        outcome.sessionId,
        epoch,
      );
    }
    // A resume the CLI could not find will never be found: the transcript is
    // gone. Keeping the id would fail every later turn the same way, so drop it
    // and let the retry start a session, losing context, not the conversation.
    // Only this chat's: every other chat's transcript is still there.
    if (!outcome.text && resuming && this.resumeRefused(outcome.error, resuming)) {
      this.opts.channel.clearChatSession(chatId);
    }
    return outcome;
  }

  /**
   * One CLI process, read to completion.
   *
   * Never rejects: everything a turn can produce, an answer, an error, a
   * killed child, is an outcome the caller decides about. The only thing this
   * owes the channel is that every stdout line is reported, whether or not it
   * carries a tool name, because that is what keeps the pane's presence alive
   * while the model does work Boxaide never sees.
   */
  private runTurn(turn: TurnRequest): Promise<TurnOutcome> {
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
        const message = err instanceof Error ? err.message : String(err);
        logError("agent.turn", "spawn failed", {
          agent: this.opts.agent,
          chat: this.loggedChat,
          seq: this.runningSeq,
          error: message,
        });
        return resolve({ text: null, sessionId: null, error: message });
      }
      this.child = child;

      const found: TurnOutcome = { text: null, sessionId: null, error: null };
      let stderr = "";
      let killed: TurnKill | null = null;
      let lastLine = Date.now();
      const startedAt = Date.now();
      logInfo("agent.turn", "start", {
        agent: this.opts.agent,
        chat: this.loggedChat,
        seq: this.runningSeq,
        pid: child.pid ?? null,
        // Whether the CLI was asked to continue a conversation, not which one.
        resuming: turn.sessionId !== null,
      });

      const watchdogMs = this.opts.watchdogMs ?? WATCHDOG_MS;
      const turnTimeoutMs = this.opts.turnTimeoutMs ?? null;
      // Ticked off whichever deadline is nearer, or the absolute one is only
      // noticed a silence-window later than it fell due.
      const tick = watchdogTickMs(Math.min(watchdogMs, turnTimeoutMs ?? watchdogMs));
      const watchdog = setInterval(() => {
        const quiet = Date.now() - lastLine >= watchdogMs;
        const overdue =
          turnTimeoutMs !== null && Date.now() - startedAt >= turnTimeoutMs;
        if (!quiet && !overdue) return;
        killed = quiet ? "silence" : "deadline";
        // SIGKILL: the deadline has already passed, and a CLI that ignores a
        // polite signal would hold the lease for the rest of the session.
        child.kill("SIGKILL");
      }, tick);

      const onStop = () => this.endChild(child);
      // An abort that landed in the gap between spawn and here never fires the
      // listener, and would leave this child running for the whole turn.
      if (this.abort.signal.aborted) onStop();
      else this.abort.signal.addEventListener("abort", onStop, { once: true });

      // One parse per line, feeding both the pane and this turn's outcome.
      const feed = this.reader(found, (tool) => {
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
        const ms = Date.now() - startedAt;
        if (found.text) {
          logInfo("agent.turn", "answered", {
            agent: this.opts.agent,
            chat: this.loggedChat,
            seq: this.runningSeq,
            code,
            ms,
            // A size, never the answer itself.
            chars: found.text.length,
          });
          return resolve({ text: found.text, sessionId: found.sessionId, error: null });
        }
        const error = this.turnError({
          code,
          killed,
          watchdogMs,
          turnTimeoutMs,
          spawnError,
          stderr,
          found,
        });
        // The line the whole module exists for. A turn that produced no answer
        // is what leaves a chat waiting, and until now the only trace of it was
        // a sentence in a pane that a reload cleared.
        logError("agent.turn", "failed", {
          agent: this.opts.agent,
          chat: this.loggedChat,
          seq: this.runningSeq,
          code,
          killed,
          ms,
          error,
          stderrTail: stderr.trim() || null,
        });
        resolve({ text: null, sessionId: found.sessionId, error });
      };
      // Spawn failures (ENOENT, EACCES) surface here and never reach "close".
      child.on("error", (err) => finish(null, err));
      // "close", not "exit": exit fires while stdout may still hold undrained
      // data, and the last thing written is the result event.
      child.on("close", (code) => finish(code));
    });
  }

  /** Why a turn that produced no answer failed, in one line fit for the pane. */
  protected turnError(ctx: TurnFailure): string {
    if (ctx.spawnError) return ctx.spawnError.message;
    if (ctx.killed === "silence") {
      return `${this.cli} went quiet for ${Math.round(ctx.watchdogMs / 1000)}s and was stopped`;
    }
    if (ctx.killed === "deadline") {
      return `${this.cli} ran for ${spell(ctx.turnTimeoutMs ?? 0)} without finishing and was stopped`;
    }
    // The CLI's own error text first: it names the cause, where an exit code only
    // says there was one.
    const reported = ctx.found.error ?? ctx.stderr.trim().split("\n").pop() ?? "";
    if (reported) return reported;
    return `${this.cli} exited ${ctx.code ?? "on a signal"} without an answer`;
  }

  /**
   * Ends a turn's child: SIGTERM, then SIGKILL if it is still there.
   *
   * The polite signal first, because the CLI writes the rest of the transcript
   * on the way out. The escalation is not the watchdog's job, that one only
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

/**
 * A duration for a sentence the user reads. Minutes once there is at least one,
 * because "960s" is a number nobody converts in their head, and seconds below
 * that so a short window in a test still reads as what it was.
 */
function spell(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)} minutes`
    : `${Math.round(ms / 1000)}s`;
}

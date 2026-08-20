/**
 * What a driven agent is, and what every driver owes the launcher.
 *
 * Two CLIs hold their loop here rather than in a prompt — OpenCode over its
 * server, Claude Code one process per turn — and the loop is the same shape in
 * both: wait on the channel, hand the turn to the model, post the answer, give
 * the lease back on failure and retry with backoff. That loop lives here once —
 * `runDrivenLoop` — and each driver supplies only its own way of taking a turn,
 * so the lease protocol cannot drift between them.
 */
import { MAX_WAIT_MS } from "./channel.js";
import type { ChatSession, UnclaimResult } from "../db/store.js";

/**
 * What a driver needs from the conversation channel.
 *
 * Structural on purpose: a driver is a loop over these calls, and stating only
 * those is what makes it testable without a database.
 */
export type DrivenTurn = { seq: number; text: string; chatId: string };

export type DriverChannel = {
  awaitUserTurn(options: {
    timeoutMs?: number;
    agent?: string | null;
    signal?: AbortSignal;
  }): Promise<DrivenTurn | null>;
  /**
   * Posts the answer to the turn it answers. False means the question is gone
   * — the user emptied or deleted the chat while the model was working — and
   * the answer was dropped rather than left somewhere nobody asked it.
   */
  answer(input: {
    seq: number;
    chatId: string;
    text: string;
    agent?: string | null;
  }): boolean;
  /**
   * Gives an unanswered lease back. The result matters: `dead_lettered` is the
   * channel saying this message will never be handed over again, which is the
   * one failure a retry cannot fix.
   */
  releaseLease(seq: number, options?: { revertAttempt?: boolean }): UnclaimResult;
  noteAgentActivity(tool: string | null): void;
  /** Gates the MCP chat tools while this loop owns the conversation. */
  setDriven(on: boolean): void;
  /** True while the chat is still carrying the user's first line as its name. */
  needsTitle(chatId: string): boolean;
  /** Offers the model's name for the chat. Refused if the user named it. */
  nameChat(chatId: string, title: string): boolean;
  /**
   * The CLI session this chat continues in, and the epoch it is good for.
   *
   * A session per chat, not per agent: one running agent answers every chat,
   * and a single shared session would feed every conversation's messages into
   * one transcript. `agent` scopes the answer because a session id only means
   * something to the CLI that issued it.
   */
  chatSession(chatId: string, agent: string): ChatSession;
  /**
   * Remembers the session a chat is living in, across agent restarts.
   *
   * `epoch` is the one read when the turn started, and the write is refused if
   * the chat's session was dropped while that turn ran. A turn takes minutes; a
   * user clearing the chat under it must not have their clear undone by the
   * answer arriving afterwards.
   */
  saveChatSession(
    chatId: string,
    agent: string,
    sessionId: string,
    epoch: number,
  ): void;
  /** Forgets one chat's session. The next turn there starts a fresh one. */
  clearChatSession(chatId: string): void;
};

/** A running driver, from the launcher's side. Stopping is idempotent. */
export type AgentDriver = {
  stop(): void;
  /**
   * Ends the turn `seq` belongs to and leaves the loop running.
   *
   * This is the user pressing Stop, not shutdown: the agent stays up and takes
   * the next message. It is the seq and not "whatever is running" because the
   * two are not the same thing: a loop that has claimed the message is not
   * necessarily prompting for it yet — it may still be finishing the previous
   * chat's naming call — and killing that would stop nothing while the stopped
   * question went on to be asked. So the seq is recorded as well as killed, and
   * a driver that meets it later refuses to hand it to the model.
   *
   * False means this driver will not honour it: it is already stopped, or it is
   * from before this existed. The message itself is closed by the channel
   * (`cancelWork`), so a driver only has to end the work.
   */
  interrupt?(seq: number): boolean;
};

/**
 * What a loop's end was, beyond the sentence explaining it.
 *
 * The reason string is written for a person to read in the pane. This is what
 * the UI can act on: a run that ended because the CLI has no sign-in is the one
 * failure the user can fix in one click, and telling it apart from a crash by
 * grepping the reason would break the first time the CLI reworded itself.
 */
export type StopCause = {
  /** The CLI is signed out. Nothing will run on it until a login lands. */
  authRequired: boolean;
};

/**
 * Why a turn that was stopped never reached the model.
 *
 * It travels the failure path like any other unanswerable turn, and is never
 * read by a person: the channel has already written the line the user sees.
 */
export const STOPPED_BY_USER = "stopped by the user";

/** Backoff after a failed turn: doubles, capped, so a dead CLI is cheap. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/**
 * How long a turn may run without a single sign of life.
 *
 * A turn can legitimately take minutes, so elapsed time alone says nothing.
 * Silence does: a working model reports every part it writes, so nothing in
 * three minutes is work that has stopped moving. Only then is the turn worth
 * abandoning, which puts the message back on the queue instead of holding the
 * lease until the user gives up and presses Stop.
 */
export const WATCHDOG_MS = 180_000;

/**
 * What the model is told about the conversation it is in.
 *
 * The KICKOFF prompt cannot apply to a driven session: it describes a loop this
 * code is running. What is left is the part the model still has to know — that
 * its answer is read by a person in another window, and that it must not send
 * mail.
 */
export const DRIVEN_SYSTEM = `You are my Boxaide inbox agent. Use the Boxaide MCP tools to read mail.

Each message you receive is from me, typed in the Boxaide window. Reply with the
answer itself — your reply text is what I read. Do not call chat_await_message,
chat_say or chat_activity: the conversation is handled for you and those are
refused. chat_history is yours to call whenever you need what was said earlier.
Draft rather than send unless I ask you to send.`;

/**
 * The one question asked purely to name a chat.
 *
 * Written for a model that has just answered a person and is inclined to keep
 * talking: it says what the answer is for, bans the decorations models put
 * around a title anyway, and gives an example of the difference between a name
 * and a category.
 */
export const TITLE_PROMPT = `Name this conversation for a list I will read a week from now.
Four words or fewer, describing what it is actually about — "Refund for the Acme
invoice", not "Email question". Reply with the name alone: no quotes, no
punctuation at the end, no explanation. This is not a message to me.`;

/**
 * How often a watchdog checks its own deadline.
 *
 * A quarter of the window, so a stalled turn is noticed well inside it, floored
 * at 10ms because tests run this with windows of a few hundred milliseconds and
 * capped at 5s because a longer window does not need a finer check.
 */
export function watchdogTickMs(windowMs: number): number {
  return Math.max(10, Math.min(windowMs / 4, 5_000));
}

/** Backoff for the nth consecutive failure, capped. */
export function backoffMs(failures: number, base = RETRY_BASE_MS): number {
  return Math.min(base * 2 ** Math.max(failures - 1, 0), RETRY_MAX_MS);
}

/** A wait that a stop() cuts short, so shutdown is never held by a backoff. */
export function abortablePause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    if (signal.aborted) return finish();
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** What a driver hands the shared loop, beyond its own way of taking a turn. */
export type DrivenLoopOptions = {
  channel: DriverChannel;
  /** Client name every turn is stamped with: the registry id. */
  agent: string;
  /** The driver's own signal. Ends the wait and the turn in flight. */
  signal: AbortSignal;
  /** Re-checked after every await: the driver's stop() has been called. */
  stopped: () => boolean;
  waitMs?: number;
  retryBaseMs?: number;
  /**
   * Consecutive failed turns before the loop gives up and returns the reason.
   *
   * Absent means never, which is right for a driver whose CLI is a separate
   * long-lived process: the server may come back, the child is still visibly
   * running, and ending the loop would leave an agent nobody prompts. Set it
   * only where the loop IS the agent, and then keep it at MAX_DELIVERIES —
   * every failed turn burns a delivery, so a cap above it can never be reached
   * by a single queued message.
   */
  maxFailures?: number;
  /**
   * Awaited after a turn is claimed and before it is handed to the model.
   *
   * Used to finish a previous naming call so the next prompt rides the same
   * session, without holding the lease until that name arrives.
   */
  beforeTurn?: () => Promise<void>;
  /**
   * Fired after the answer is posted. Must not throw: the lease is already
   * closed and a throw here would be read as a failed turn.
   */
  afterReply?: (chatId: string) => void;
};

/**
 * The driven chat loop: wait, take the turn, post the answer, retry on failure.
 *
 * Returns null when it was stopped, or the reason it gave up — which for a
 * driver that owns no long-lived child is the only exit the launcher will ever
 * see. It never rejects: every throw the loop can meet, including one from the
 * channel itself, comes back as that reason. An unhandled rejection here used
 * to kill the whole Boxaide process, and it did it at shutdown — after the stop
 * had already been recorded as clean.
 */
export async function runDrivenLoop(
  loop: DrivenLoopOptions,
  // The whole turn, not just its text: which chat a message came from decides
  // which session answers it.
  takeTurn: (turn: DrivenTurn) => Promise<string>,
): Promise<string | null> {
  let failures = 0;
  while (!loop.stopped()) {
    let turn: DrivenTurn | null;
    try {
      turn = await loop.channel.awaitUserTurn({
        timeoutMs: loop.waitMs ?? MAX_WAIT_MS,
        agent: loop.agent,
        signal: loop.signal,
      });
    } catch (err) {
      // The channel is this loop's only input, and a throw here is not a failed
      // turn: nothing was handed over, so there is nothing to give back and
      // nothing a retry could reach. Shutdown closing the store under a wait
      // that was already parked is exactly this case.
      return describe(err);
    }
    // Null is the normal timeout, and the whole point of asking again.
    if (!turn) continue;
    if (loop.stopped()) {
      release(loop, turn.seq, { revertAttempt: true });
      return null;
    }
    try {
      loop.channel.noteAgentActivity("prompt");
      // A naming call from the previous turn may still be running. Waiting
      // here rather than before taking the message is the difference between
      // an answer the user can see coming and one that sits in the queue.
      if (loop.beforeTurn) await loop.beforeTurn();
      if (loop.stopped()) {
        release(loop, turn.seq, { revertAttempt: true });
        return null;
      }
      const reply = await takeTurn(turn);
      const posted = loop.channel.answer({
        seq: turn.seq,
        chatId: turn.chatId,
        text: reply,
        agent: loop.agent,
      });
      // The model answered, so the turn worked. Whether the user still wanted
      // it is a different question and not a failure of this loop.
      failures = 0;
      try {
        // Nothing to name when the exchange it would be named from is gone.
        if (posted) loop.afterReply?.(turn.chatId);
      } catch {
        // Naming is best effort. The answer is already posted.
      }
      continue;
    } catch (err) {
      if (loop.stopped()) {
        release(loop, turn.seq, { revertAttempt: true });
        return null;
      }
      // Give the message back rather than swallow it: the next attempt is handed
      // the same turn, and the delivery cap ends it if the CLI stays broken.
      const gave = release(loop, turn.seq);
      // The question is already answered — the user pressed Stop, which closes
      // the lease with a line of its own. Nothing failed that a retry could
      // fix, and counting it would spend the give-up budget on the user's own
      // button. Straight back to waiting, at full speed.
      if (gave === "acked") {
        failures = 0;
        continue;
      }
      failures += 1;
      // A cap means this loop is the agent, so a dead end has to be reported
      // instead of spun on: without an exit the pane shows a live agent that
      // silently answers nothing. `dead_lettered` is that dead end arriving
      // early — the message is gone, so the next attempt would wait on a queue
      // this failure just emptied.
      if (
        loop.maxFailures !== undefined &&
        (failures >= loop.maxFailures || gave === "dead_lettered")
      ) {
        return describe(err);
      }
      await abortablePause(
        loop.signal,
        backoffMs(failures, loop.retryBaseMs ?? RETRY_BASE_MS),
      );
    }
  }
  return null;
}

/**
 * A release that cannot end the loop by throwing.
 *
 * The lease is the channel's bookkeeping, and at shutdown its store may already
 * be closed. Failing to hand a message back is not worth losing the exit report
 * over: the next process release orphaned leases on startup.
 */
function release(
  loop: DrivenLoopOptions,
  seq: number,
  options?: { revertAttempt?: boolean },
): UnclaimResult {
  try {
    return loop.channel.releaseLease(seq, options);
  } catch {
    return "missing";
  }
}

/** A reason the launcher can show. Never empty: `onStop(null)` means stopped. */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.trim() || "the agent loop failed";
}

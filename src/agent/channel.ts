/**
 * The agent conversation channel.
 *
 * Boxaide does not run a model and does not spawn an agent. The agent is
 * whatever MCP client the user already has — Claude Code, Codex, Cursor,
 * Claude Desktop, anything that speaks MCP — and this is the surface that lets
 * that agent hold a conversation inside the Boxaide window instead of in its
 * own terminal.
 *
 * The whole protocol is three tools and one rule:
 *
 *   1. `chat_await_message` blocks until the user types something, or until it
 *      times out. The agent calls it in a loop.
 *   2. `chat_say` posts the agent's answer.
 *   3. `chat_activity` posts a one-line "here is what I am doing right now".
 *
 * Nothing here is specific to any client, because a long-polling tool call is
 * the one capability every MCP client has. Server-initiated sampling and
 * elicitation would be a cleaner fit on paper, and almost nothing implements
 * them.
 *
 * A message is delivered to exactly ONE waiting agent. Two agents pointed at
 * the same Boxaide would otherwise both answer every message.
 *
 * ## Why this polls its own database
 *
 * `boxaide mcp` (stdio) is a SEPARATE PROCESS from `boxaide serve`. Both open
 * the same SQLite file, so the two see each other's turns on disk and nothing
 * else: an in-memory listener set cannot cross a process boundary. Waking
 * purely on in-process `post()` would leave a stdio agent parked until its poll
 * timed out — 25 seconds to answer "hello" — and would leave the browser's SSE
 * stream never showing what that agent said at all.
 *
 * So the database is the bus. A short interval runs while anything is attached
 * and drains new rows to listeners and waiters alike. In-process posts also
 * drain immediately, so the common case costs nothing in latency and the
 * interval is only there for the cross-process one.
 */
import type { Store, StoredTurn } from "../db/store.js";

export type Turn = StoredTurn;

/** Turns kept on disk. Older ones are dropped as new ones arrive. */
const HISTORY_LIMIT = 500;

/** Default long-poll, in ms. Under the 60s tool timeout common in MCP clients. */
export const DEFAULT_WAIT_MS = 25_000;
export const MAX_WAIT_MS = 110_000;

/** Cross-process pickup interval. Only runs while a waiter or listener exists. */
const POLL_MS = 400;

/**
 * How long after its last call an agent still counts as present.
 *
 * An agent parked in `chat_await_message` is provably there — the call is open.
 * One that is off doing tool work is not, so its last call stands in for it,
 * and the window is wider than the default poll so a normal loop does not blink
 * out between iterations.
 */
const PRESENCE_WINDOW_MS = 40_000;

/**
 * How long a claimed message may stay unanswered, WITHOUT PROOF the agent
 * holding it is alive, before we stop saying an agent is working on it.
 *
 * An agent that took a message and then died leaves no trace: the claim is a
 * database flag, not an open request. Rather than show a spinner forever, the
 * claim expires, and expiring it tells the user the message is gone and must
 * be sent again.
 *
 * The clock runs from the last proof, not from the hand-off. Timing the
 * hand-off would call a live agent dead for the only reason an answer ever
 * takes this long — a big question, worked patiently — and the pane would
 * print "never answered" over an agent that answers two minutes later. Proof
 * is a Boxaide tool call, or a line on a launched agent's stdout; a dead agent
 * produces neither, so it still expires five minutes after its last sign of
 * life.
 *
 * This clock does not run at all for an agent Boxaide launched. There the
 * running child process is the proof, it never lapses while the process
 * lives, and its exit ends the claim outright — see `presence`.
 */
const WORK_MAX_MS = 5 * 60_000;

/**
 * Floor on how often a launched agent's own output may push a presence event.
 *
 * That stream is a firehose — Grok narrates its thinking one token per line —
 * and every line refreshes the same timestamp. Presence only has to stay
 * inside PRESENCE_WINDOW_MS, so re-announcing it a few times a second buys
 * nothing and costs an SSE frame each time. A changed tool name is not
 * throttled: that one is news.
 */
const ACTIVITY_EMIT_MS = 5_000;

/**
 * What an agent is doing right now, when it is doing anything.
 *
 * This is the one thing about an agent's own work that Boxaide can prove. A
 * message is handed to exactly one agent, and that hand-off is a write this
 * process performs; the answer that ends it is another. Between the two, the
 * agent has the message and has not answered — no model is being watched and
 * nothing is inferred from silence.
 */
export type Work = {
  /** The user turn that was claimed. */
  seq: number;
  /** When it was handed over. */
  since: string;
  /** The claiming agent's client name, when it gave one. */
  agent: string | null;
  /**
   * The last tool it started since: a Boxaide tool it called, or, for an agent
   * Boxaide launched, whatever its own event stream named. Absent until one of
   * the two reports something.
   */
  tool: { name: string; at: string } | null;
};

export type Presence = {
  /** Agents currently blocked in chat_await_message. Provable, not inferred. */
  waiting: number;
  /** True while an agent is waiting, or called within the presence window. */
  listening: boolean;
  lastSeenAt: string | null;
  /**
   * Name the header should show: the launched CLI if one is running, else
   * the last MCP initialize name.
   */
  lastAgent: string | null;
  /**
   * Registry id of the CLI Boxaide spawned (sidebar Start). The header uses
   * this to show a name before the process has called chat_await_message.
   */
  launchedAgent: string | null;
  /** Set while a claimed message is unanswered. Null the rest of the time. */
  working: Work | null;
};

type Waiter = {
  resolve: (turn: Turn | null) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Client name of the parked agent, for the work record it may claim. */
  agent: string | null;
};

export class AgentChannel {
  private listeners = new Set<(turn: Turn) => void>();
  private presenceListeners = new Set<() => void>();
  private waiters: Waiter[] = [];
  private lastSeen: number | null = null;
  /** When a launched agent's stream last pushed presence. See ACTIVITY_EMIT_MS. */
  private lastActivityEmit = 0;
  private lastAgent: string | null = null;
  private launchedAgent: string | null = null;
  /** The message an agent has taken and not yet answered. */
  private work: (Work & { provenAt: number }) | null = null;
  /**
   * Distinct client names that have asked for a message since the launched
   * agent started. Sized, not read: see `streamSpeaksForWork`.
   */
  private askers = new Set<string>();
  /** Highest seq handed to listeners. Advanced only by drain(). */
  private broadcastSeq: number;
  private poll: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private store: Store) {
    // Start from the end of history: attaching a listener replays nothing, it
    // only follows. The UI fetches history separately.
    const tail = this.store.listTurns({ limit: 1 });
    this.broadcastSeq = tail.length > 0 ? tail[tail.length - 1].seq : 0;
  }

  /* ---- writing ---------------------------------------------------------- */

  /**
   * Appends a turn and wakes whatever is watching.
   *
   * A user turn is offered to one waiting agent; if none is waiting it stays
   * unclaimed on disk until one asks, which is what makes "type first, start
   * the agent second" work.
   */
  post(input: { role: Turn["role"]; text: string; agent?: string | null }): Turn {
    const text = input.text.trim();
    if (!text) throw new Error("text is required");
    if (input.role !== "user") this.touch(input.agent ?? null);
    // Stamp before clearing: the claimed seq is the owner, even if another
    // user turn arrived while this work was open.
    const replyTo =
      (input.role === "agent" || input.role === "activity") && this.work
        ? this.work.seq
        : null;
    // The answer is what ends the work. An activity line does not: the agent
    // is narrating mid-task and is still holding the message.
    if (input.role === "agent") this.work = null;

    const turn = this.store.appendTurn({
      at: new Date().toISOString(),
      role: input.role,
      text,
      agent: input.agent ?? null,
      replyTo,
    });
    this.store.trimTurns(HISTORY_LIMIT);

    // Listeners first: the UI should paint the message before it is handed to
    // an agent, not after.
    this.drain();
    if (input.role === "user") this.handOff();
    return turn;
  }

  /* ---- reading ---------------------------------------------------------- */

  history(afterSeq?: number): Turn[] {
    return this.store.listTurns({ afterSeq, limit: HISTORY_LIMIT });
  }

  /** Live turns, for the SSE route. */
  subscribe(listener: (turn: Turn) => void): () => void {
    this.listeners.add(listener);
    this.ensurePoll();
    return () => {
      this.listeners.delete(listener);
      this.maybeStopPoll();
    };
  }

  /**
   * Presence changes, for the SSE route.
   *
   * Turns are not enough: an agent parking in `chat_await_message` produces no
   * row, and a `chat_say` that the UI already painted still has to flip the
   * listening badge. No replay — the caller reads `presence()` itself.
   */
  subscribePresence(listener: () => void): () => void {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  }

  presence(): Presence {
    const now = Date.now();
    const fresh = this.lastSeen !== null && now - this.lastSeen < PRESENCE_WINDOW_MS;
    // A process we started is still running and this claim is its own: no
    // timer may overrule that. Stdout goes quiet for as long as one tool call
    // takes — a test run, a build, a long read — and a claim that expired
    // underneath it would tell the user their answer is never coming while
    // the agent is a minute from giving it. When the child exits, the exit
    // itself ends the claim, so nothing here has to guess.
    const held = this.work !== null && this.streamSpeaksForWork();
    if (this.work && !held && now - this.work.provenAt > WORK_MAX_MS) {
      this.work = null;
    }
    return {
      waiting: this.waiters.length,
      listening: this.waiters.length > 0 || fresh,
      lastSeenAt:
        this.lastSeen === null ? null : new Date(this.lastSeen).toISOString(),
      lastAgent: this.launchedAgent ?? this.lastAgent,
      launchedAgent: this.launchedAgent,
      working: this.work
        ? {
            seq: this.work.seq,
            since: this.work.since,
            agent: this.work.agent,
            tool: this.work.tool,
          }
        : null,
    };
  }

  /**
   * Records a mail tool call, so a working agent's steps are visible even when
   * it never calls `chat_activity`.
   *
   * Only kept while a claimed message is open. A client using the mail tools
   * outside the conversation is not answering anybody, and its calls must not
   * be drawn as steps under somebody's question.
   */
  noteToolCall(tool: string): void {
    if (this.work) {
      this.work.tool = { name: tool, at: new Date().toISOString() };
      // Working the message, not gone. This is the only proof an agent
      // Boxaide did not launch can offer, and it is enough.
      this.proveWork();
    }
    // The call itself is proof the agent is alive, work or no work.
    this.touch(null);
  }

  /**
   * Records a line from a launched agent's own event stream.
   *
   * Same two effects as `noteToolCall` and a stricter claim behind them. An
   * MCP call proves the agent was alive when it called; a line on the child's
   * stdout proves the process this server started is alive right now, and
   * names work that never comes near Boxaide — a file it read, a command it
   * ran, a sentence it thought. That is the gap this closes: an agent doing
   * its own work used to look, from here, exactly like an agent that had died.
   *
   * Only agents Boxaide launched have a stream to read. A client that
   * connected over MCP on its own has no child process, so its silence stays
   * unreadable and the UI says so rather than guessing.
   */
  noteAgentActivity(tool: string | null): void {
    const speaks = this.work !== null && this.streamSpeaksForWork();
    const renamed = speaks && tool !== null && tool !== this.work?.tool?.name;
    // No proveWork here, deliberately: while the stream speaks for the claim
    // the process is running, and `presence` does not expire it on any clock.
    if (speaks && tool) {
      this.work!.tool = { name: tool, at: new Date().toISOString() };
    }
    // Not touch(): that emits on every call, and this one arrives per line.
    this.lastSeen = Date.now();
    if (renamed || this.lastSeen - this.lastActivityEmit >= ACTIVITY_EMIT_MS) {
      this.lastActivityEmit = this.lastSeen;
      this.emitPresence();
    }
  }

  /* ---- the long poll ---------------------------------------------------- */

  /**
   * Resolves with the next unclaimed user message, or null once `timeoutMs`
   * passes with nothing to hand over.
   *
   * Null is a normal result, not an error: it exists so the agent's client sees
   * a completed tool call well inside its request timeout and can immediately
   * call again. The tool description tells the agent to do exactly that.
   */
  awaitUserTurn(
    options: { timeoutMs?: number; agent?: string | null } = {},
  ): Promise<Turn | null> {
    const agent = options.agent ?? null;
    // Asking is what makes a client a candidate for the next hand-off, so this
    // is the point where a second agent becomes real. An unnamed client counts
    // as one name: two anonymous clients are still two agents.
    this.askers.add(agent ?? "");
    this.touch(agent);
    // Back at the loop means done with the last message, answered or abandoned.
    this.work = null;
    if (this.closed) return Promise.resolve(null);

    // Anything typed before the agent got here is already on disk.
    const pending = this.store.claimNextUserTurn();
    if (pending) {
      this.beginWork(pending, agent);
      this.emitPresence();
      return Promise.resolve(pending);
    }

    const ms = Math.min(
      Math.max(options.timeoutMs ?? DEFAULT_WAIT_MS, 1_000),
      MAX_WAIT_MS,
    );
    return new Promise<Turn | null>((resolve) => {
      const waiter: Waiter = {
        agent,
        resolve,
        timer: setTimeout(() => {
          this.drop(waiter);
          resolve(null);
        }, ms),
      };
      this.waiters.push(waiter);
      this.ensurePoll();
      this.emitPresence();
    });
  }

  /* ---- the bus ---------------------------------------------------------- */

  /**
   * Reads every turn newer than the last broadcast and pushes it out, in order.
   *
   * Reading back from the database rather than broadcasting the object `post`
   * just built is deliberate: another process may have inserted a row in
   * between, and jumping `broadcastSeq` straight to the new turn would step
   * over it permanently.
   */
  private drain(): void {
    const fresh = this.store.listTurns({ afterSeq: this.broadcastSeq });
    if (fresh.length === 0) return;
    this.broadcastSeq = fresh[fresh.length - 1].seq;
    if (this.listeners.size === 0) return;
    for (const turn of fresh) {
      for (const listener of this.listeners) {
        try {
          listener(turn);
        } catch {
          // A broken SSE writer must not stop the others, or fail the post.
        }
      }
    }
  }

  /** Hands the oldest unclaimed user turn to the longest-waiting agent. */
  private handOff(): void {
    let handed = false;
    while (this.waiters.length > 0) {
      const turn = this.store.claimNextUserTurn();
      if (!turn) break;
      const waiter = this.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      this.beginWork(turn, waiter.agent);
      waiter.resolve(turn);
      handed = true;
    }
    if (handed) this.emitPresence();
  }

  /** One agent now holds one message. Ends at its next answer, or by expiry. */
  private beginWork(turn: Turn, agent: string | null): void {
    this.work = {
      seq: turn.seq,
      since: new Date().toISOString(),
      // The hand-off is itself the first proof: the agent asked, and got one.
      provenAt: Date.now(),
      agent: agent ?? this.lastAgent,
      tool: null,
    };
  }

  /**
   * Restarts the expiry clock: this agent is still on the message.
   *
   * Kept separate from `touch` because the two answer different questions.
   * `touch` says an agent exists; this says the one holding this message has
   * not abandoned it.
   */
  private proveWork(): void {
    if (this.work) this.work.provenAt = Date.now();
  }

  /**
   * Whether a launched agent's stdout may speak for the open claim.
   *
   * The stream proves what the child process is doing. It does not prove that
   * the child is the agent holding the message — HTTP MCP is stateless here,
   * so a claim cannot be tied back to the client that made it. With one agent
   * asking, there is nobody else it could be. With two, a launched CLI's file
   * reads would be drawn as steps under a question Claude Desktop took, and a
   * silent, dead claimant would be kept alive by the other one's output.
   *
   * So the label and the expiry clock are conceded the moment a second name
   * asks for a message. Liveness is not: that one is about the process, and
   * the process is provably running either way.
   */
  private streamSpeaksForWork(): boolean {
    return this.launchedAgent !== null && this.askers.size <= 1;
  }

  private ensurePoll(): void {
    if (this.poll || this.closed) return;
    this.poll = setInterval(() => {
      this.drain();
      this.handOff();
    }, POLL_MS);
    // Never hold the process open for a poll that exists to serve attachments.
    this.poll.unref?.();
  }

  private maybeStopPoll(): void {
    if (!this.poll) return;
    if (this.listeners.size > 0 || this.waiters.length > 0) return;
    clearInterval(this.poll);
    this.poll = null;
  }

  private drop(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.maybeStopPoll();
    if (index >= 0) this.emitPresence();
  }

  private touch(agent: string | null): void {
    this.lastSeen = Date.now();
    // A launched CLI stamps turns as itself. Do not copy that stamp onto
    // lastAgent, or Stop loses the last MCP client name.
    if (agent && !this.launchedAgent) this.lastAgent = agent;
    this.emitPresence();
  }

  private emitPresence(): void {
    for (const listener of this.presenceListeners) {
      try {
        listener();
      } catch {
        // Same rule as drain: a broken SSE writer must not fail the call.
      }
    }
  }

  /**
   * Records the client name from an MCP `initialize`.
   *
   * Best effort, and labelled that way wherever it is shown. HTTP MCP is
   * stateless here — there is no session id tying a later tools/call back to
   * the handshake that named the client — so with two different clients
   * connected this is whichever initialized most recently. A launched agent
   * (setLaunchedAgent) wins the header and new turn stamps while it runs.
   */
  noteClient(name: string | null): void {
    if (!name || name === this.lastAgent) return;
    this.lastAgent = name;
    this.emitPresence();
  }

  /**
   * The CLI Boxaide spawned. Wins the header and new turn stamps until the
   * process exits. The previous MCP name is kept and returns on Stop.
   */
  setLaunchedAgent(id: string | null): void {
    if (id === this.launchedAgent) return;
    // Read ownership before the id moves: after this, streamSpeaksForWork is
    // answering about a different process, or none.
    const wasOurs = this.streamSpeaksForWork();
    const stopped = id === null;
    this.launchedAgent = id;
    // A fresh process gets a fresh count. Whoever was asking before this one
    // started may be long gone, and a name from then must not mute the stream
    // for the rest of the session.
    this.askers.clear();
    // It took a message and exited without answering. That is the case the
    // expiry was built for, and the exit proves it outright — so say it now
    // instead of leaving a spinner up for five more minutes. An agent that
    // answered first cleared this on the way out and there is nothing here.
    if (stopped && wasOurs && this.work) this.work = null;
    this.emitPresence();
  }

  /** Who new agent turns are stamped as: the launched CLI, else last initialize. */
  get clientName(): string | null {
    return this.launchedAgent ?? this.lastAgent;
  }

  /* ---- lifecycle -------------------------------------------------------- */

  clear(): void {
    this.store.clearTurns();
    this.broadcastSeq = 0;
    // The claimed message went with the history; nothing is being answered.
    this.work = null;
    this.emitPresence();
  }

  /**
   * Releases every parked agent. Called on shutdown so a long poll cannot hold
   * the process open past `stop()`.
   */
  close(): void {
    this.closed = true;
    this.work = null;
    const parked = this.waiters.splice(0);
    for (const waiter of parked) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.listeners.clear();
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
}

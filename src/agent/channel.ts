/**
 * The agent conversation channel.
 *
 * mailmux does not run a model and does not spawn an agent. The agent is
 * whatever MCP client the user already has — Claude Code, Codex, Cursor,
 * Claude Desktop, anything that speaks MCP — and this is the surface that lets
 * that agent hold a conversation inside the mailmux window instead of in its
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
 * the same mailmux would otherwise both answer every message.
 *
 * ## Why this polls its own database
 *
 * `mailmux mcp` (stdio) is a SEPARATE PROCESS from `mailmux serve`. Both open
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
   * Registry id of the CLI mailmux spawned (sidebar Start). The header uses
   * this to show a name before the process has called chat_await_message.
   */
  launchedAgent: string | null;
};

type Waiter = {
  resolve: (turn: Turn | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class AgentChannel {
  private listeners = new Set<(turn: Turn) => void>();
  private presenceListeners = new Set<() => void>();
  private waiters: Waiter[] = [];
  private lastSeen: number | null = null;
  private lastAgent: string | null = null;
  private launchedAgent: string | null = null;
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

    const turn = this.store.appendTurn({
      at: new Date().toISOString(),
      role: input.role,
      text,
      agent: input.agent ?? null,
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
    const fresh =
      this.lastSeen !== null && Date.now() - this.lastSeen < PRESENCE_WINDOW_MS;
    return {
      waiting: this.waiters.length,
      listening: this.waiters.length > 0 || fresh,
      lastSeenAt:
        this.lastSeen === null ? null : new Date(this.lastSeen).toISOString(),
      lastAgent: this.launchedAgent ?? this.lastAgent,
      launchedAgent: this.launchedAgent,
    };
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
    this.touch(options.agent ?? null);
    if (this.closed) return Promise.resolve(null);

    // Anything typed before the agent got here is already on disk.
    const pending = this.store.claimNextUserTurn();
    if (pending) return Promise.resolve(pending);

    const ms = Math.min(
      Math.max(options.timeoutMs ?? DEFAULT_WAIT_MS, 1_000),
      MAX_WAIT_MS,
    );
    return new Promise<Turn | null>((resolve) => {
      const waiter: Waiter = {
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
      waiter.resolve(turn);
      handed = true;
    }
    if (handed) this.emitPresence();
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
   * The CLI mailmux spawned. Wins the header and new turn stamps until the
   * process exits. The previous MCP name is kept and returns on Stop.
   */
  setLaunchedAgent(id: string | null): void {
    if (id === this.launchedAgent) return;
    this.launchedAgent = id;
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
  }

  /**
   * Releases every parked agent. Called on shutdown so a long poll cannot hold
   * the process open past `stop()`.
   */
  close(): void {
    this.closed = true;
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

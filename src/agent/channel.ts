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
 * A message is leased to exactly ONE waiting agent. Two agents pointed at
 * the same Boxaide would otherwise both answer every message. The lease ends
 * at `chat_say`, or when the holder is gone — abort, expiry, process exit,
 * or the same agent returning to the loop unanswered. After a few failed
 * leases the row is dead-lettered and the UI asks the user to send it again.
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
import {
  MAX_DELIVERIES,
  type Store,
  type StoredChat,
  type StoredTurn,
} from "../db/store.js";

export type Turn = StoredTurn;
export type Chat = StoredChat;
export { MAX_DELIVERIES };

/** Turns kept on disk PER CHAT. Older ones are dropped as new ones arrive. */
const HISTORY_LIMIT = 500;

/**
 * Bytes of conversation text kept before old chats are archived.
 *
 * Chat text is small — this is tens of thousands of messages, not a disk
 * pressure valve. It is here so the store cannot grow without a number the
 * user can see, and so archiving is a rule rather than a surprise.
 */
const DEFAULT_BUDGET_BYTES = 50 * 1024 * 1024;

function budgetBytes(): number {
  const raw = process.env.BOXAIDE_CHAT_BUDGET_MB;
  const mb = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_BUDGET_BYTES;
  return Math.round(mb * 1024 * 1024);
}

/** Longest a title derived from a first message may be. */
const TITLE_CHARS = 60;

/**
 * A chat's name, taken from its first message.
 *
 * First line only, and cut on a word. The alternative is asking the user to
 * name a conversation before they have had it.
 */
function titleFrom(text: string): string {
  const line = text.split("\n").find((part) => part.trim().length > 0) ?? text;
  return shorten(line.trim().replace(/\s+/g, " "));
}

/**
 * One line, cut to length on a word, and marked where it was cut.
 *
 * Every title in the rail goes through this, whoever wrote it. A cut that is
 * not marked reads as a name somebody chose, and the reader cannot tell a
 * short title from the front half of a long one.
 */
function shorten(clean: string): string {
  if (clean.length <= TITLE_CHARS) return clean;
  const cut = clean.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Longest a model's answer may be and still be read as a title.
 *
 * Asked for four words, a model sometimes writes a sentence about the chat
 * instead. Cutting that to 60 characters would put half a sentence in the rail,
 * which reads worse than the first line the user typed. Past this it is prose,
 * and prose is refused rather than trimmed.
 */
const TITLE_MAX_RAW = 120;

/**
 * A model's answer, turned into a title or into nothing.
 *
 * Models wrap titles in quotes, bold them, and prefix them with "Title:" no
 * matter how the question is put, so all three come off here. What is left is
 * one line of plain text, or nothing — and nothing keeps the title the first
 * message gave the chat.
 */
/** Drops the characters that would break a single-line label. */
function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

export function cleanTitle(raw: string): string | null {
  const line = raw.split("\n").find((part) => part.trim().length > 0);
  if (!line) return null;
  let clean = stripControl(line)
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^(?:title|chat|name)\s*[:\-\u2014]\s*/i, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Quotes come off in pairs only: a title that is one half of a quotation is
  // more likely to be using the character than wrapped in it.
  const quoted =
    /^(["'])(.*)\1$/.exec(clean) ?? /^[\u201c\u2018](.*)[\u201d\u2019]$/.exec(clean);
  if (quoted) clean = (quoted[2] ?? quoted[1] ?? "").trim();
  clean = clean.replace(/[.。]+$/, "").trim();
  if (!clean || clean.length > TITLE_MAX_RAW) return null;
  return shorten(clean) || null;
}

/** What the storage line in the rail reads from. */
export type ChatStorage = {
  bytes: number;
  budget: number;
  chats: number;
  archived: number;
};

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
 * holding it is alive, before we give the lease back.
 *
 * An agent that took a message and then died leaves no trace: the claim is a
 * database flag, not an open request. Rather than show a spinner forever, the
 * lease expires and the next waiting agent is offered the same message.
 * After MAX_DELIVERIES failed leases it stays claimed, and the UI tells the
 * user it will not be handed over again.
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
  /**
   * The chat that turn came from. The answer goes back here, not to whatever
   * the user has since clicked on: a question asked in one conversation must
   * not be answered in another.
   */
  chatId: string;
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
  /**
   * User seqs leased until the delivery cap and never answered. The warning
   * in the pane is these, not a row that is still queued or still in flight.
   * Absent on a server built before the field existed — treat as none.
   */
  dropped: number[];
  /** The chat the composer writes to. */
  activeChatId: string;
};

type Waiter = {
  resolve: (turn: Turn | null) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Client name of the parked agent, for the work record it may claim. */
  agent: string | null;
  /** Present when the MCP request that parked this waiter can be cancelled. */
  signal?: AbortSignal;
  /** Remove the abort listener, if one was attached. */
  cleanup?: () => void;
};

export class AgentChannel {
  private listeners = new Set<(turn: Turn) => void>();
  private presenceListeners = new Set<() => void>();
  private chatListeners = new Set<() => void>();
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
  /**
   * What the chat list looked like when it was last emitted.
   *
   * A rename writes no turn, so the drain cannot see one. This is compared on
   * the same poll, and it is how a title written by `boxaide mcp` reaches a
   * browser attached to `boxaide serve`.
   */
  private chatsFingerprint: string;
  private poll: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /**
   * True while an in-process driver holds the chat loop. The MCP chat tools
   * are refused for the duration: a driven CLI that still called
   * `chat_await_message` would present as the same holder the driver uses,
   * take the lease out from under it, and answer twice. A prompt telling the
   * model not to is a sentence; this is the gate.
   */
  private drivenFlag = false;

  constructor(private store: Store) {
    // Start from the end of history: attaching a listener replays nothing, it
    // only follows. The UI fetches history separately.
    const tail = this.store.listTurns({ limit: 1 });
    this.broadcastSeq = tail.length > 0 ? tail[tail.length - 1].seq : 0;
    this.chatsFingerprint = this.store.chatsFingerprint();
    // This process just started. Any lease in the file is held by nobody —
    // the previous process's in-memory work died with it.
    this.store.releaseOrphanLeases();
  }

  /* ---- writing ---------------------------------------------------------- */

  /**
   * Appends a turn and wakes whatever is watching.
   *
   * A user turn is offered to one waiting agent; if none is waiting it stays
   * unclaimed on disk until one asks, which is what makes "type first, start
   * the agent second" work.
   *
   * `chatId` is the pane naming the conversation it is showing. Two windows can
   * have different chats open, and the active chat is one server-wide row, so a
   * send that trusted it would land in whichever chat was selected last and
   * vanish from the pane that typed it. The named chat also becomes the active
   * one: the hand-off and every later default follow the user's latest send.
   * Callers must check `writable` first — this refuses an unknown or archived
   * chat rather than quietly writing somewhere else.
   */
  post(input: {
    role: Turn["role"];
    text: string;
    agent?: string | null;
    chatId?: string;
  }): Turn {
    const text = input.text.trim();
    if (!text) throw new Error("text is required");
    if (input.role === "user" && input.chatId) {
      if (!this.selectChat(input.chatId)) throw new Error("no such chat");
    }
    if (input.role !== "user") this.touch(input.agent ?? null);
    // Stamp before clearing: the claimed seq is the owner, even if another
    // user turn arrived while this work was open.
    const answering = input.role === "agent" || input.role === "activity";
    const replyTo = answering && this.work ? this.work.seq : null;
    // An answer belongs to the chat the question was asked in. Only a turn
    // that answers nothing lands wherever the user is now.
    const chatId =
      answering && this.work
        ? this.work.chatId
        : this.store.ensureActiveChat().id;
    // The answer is what ends the work. An activity line does not: the agent
    // is narrating mid-task and is still holding the message.
    if (input.role === "agent") this.work = null;

    const turn = this.store.appendTurn({
      at: new Date().toISOString(),
      chatId,
      role: input.role,
      text,
      agent: input.agent ?? null,
      replyTo,
    });
    // The first thing said in a chat names it, so the row is never blank while
    // the agent is still reading. The agent replaces that guess once, with a
    // name written from the whole exchange — see nameChat. Nothing renames it
    // after that: a list whose rows change under the reader is not a list.
    if (input.role === "user" && this.store.isUntitled(chatId)) {
      this.store.renameChat(chatId, titleFrom(text), "auto");
    }
    this.store.trimTurns(chatId, HISTORY_LIMIT);
    this.enforceBudget();

    // Listeners first: the UI should paint the message before it is handed to
    // an agent, not after.
    this.drain();
    this.emitChats();
    if (input.role === "user") this.handOff();
    return turn;
  }

  /**
   * Archives the oldest chats until the store is back inside its budget.
   *
   * Oldest first, active chat never, and the record always kept. The user is
   * told after the fact rather than asked beforehand: a prompt that appears
   * because of a byte count is a prompt somebody dismisses without reading.
   */
  private enforceBudget(): void {
    const budget = budgetBytes();
    let bytes = this.store.chatBytes();
    if (bytes <= budget) return;
    for (const candidate of this.store.archiveCandidates()) {
      if (bytes <= budget) break;
      if (this.store.archiveChat(candidate.id)) bytes -= candidate.bytes;
    }
  }

  /* ---- reading ---------------------------------------------------------- */

  /** Turns of one chat, or of the active one when no id is given. */
  history(afterSeq?: number, chatId?: string): Turn[] {
    const id = chatId ?? this.store.ensureActiveChat().id;
    return this.store.listTurns({ afterSeq, chatId: id, limit: HISTORY_LIMIT });
  }

  /* ---- chats ------------------------------------------------------------ */

  chats(options: { includeArchived?: boolean } = {}): Chat[] {
    // Reading the list is also the moment to guarantee there is one to read.
    this.store.ensureActiveChat();
    return this.store.listChats(options);
  }

  storage(): ChatStorage {
    const all = this.store.listChats({ includeArchived: true });
    return {
      bytes: this.store.chatBytes(),
      budget: budgetBytes(),
      chats: all.filter((chat) => chat.archivedAt === null).length,
      archived: all.filter((chat) => chat.archivedAt !== null).length,
    };
  }

  activeChat(): Chat {
    return this.store.ensureActiveChat();
  }

  /**
   * Whether a chat may be written to. An archived chat is a record, not a
   * conversation, so it is not one. Routes ask this to answer 404 before they
   * hand an id to `post` or `clear`.
   */
  writable(id: string): boolean {
    const chat = this.store.getChat(id);
    return chat !== null && chat.archivedAt === null;
  }

  createChat(): Chat {
    const chat = this.store.createChat();
    this.emitChats();
    this.emitPresence();
    return chat;
  }

  selectChat(id: string): boolean {
    const ok = this.store.selectChat(id);
    if (ok) {
      this.emitChats();
      this.emitPresence();
    }
    return ok;
  }

  renameChat(id: string, title: string): boolean {
    const ok = this.store.renameChat(id, title.trim().slice(0, TITLE_CHARS));
    if (ok) this.emitChats();
    return ok;
  }

  /**
   * Whether this chat is still waiting for a name worth reading.
   *
   * The agent asks — through the MCP payload, or through the driver — so that a
   * chat the user has already named costs nobody a second thought.
   */
  needsTitle(id: string): boolean {
    return this.store.titleSource(id) === "auto";
  }

  /**
   * The agent's name for a chat, from having read the exchange.
   *
   * Offered, not imposed: a chat the user renamed keeps the user's name, and a
   * chat already named this way keeps the first one, so the row does not move
   * under a reader who has learned where it is. A name that survives sanitising
   * to nothing is no name, and the derived one stands.
   */
  nameChat(id: string, title: string): boolean {
    const clean = cleanTitle(title);
    if (!clean) return false;
    const ok = this.store.renameChat(id, clean, "agent");
    if (ok) this.emitChats();
    return ok;
  }

  archiveChat(id: string): boolean {
    const ok = this.store.archiveChat(id);
    if (ok) this.afterChatRemoved(id);
    return ok;
  }

  deleteChat(id: string): boolean {
    const ok = this.store.deleteChat(id);
    if (ok) this.afterChatRemoved(id);
    return ok;
  }

  /**
   * A chat just lost its messages. If an agent was answering one of them,
   * that lease is over — the question it was holding no longer exists.
   */
  private afterChatRemoved(id: string): void {
    if (this.work?.chatId === id) this.work = null;
    this.store.ensureActiveChat();
    this.emitChats();
    this.emitPresence();
  }

  /** Chat list changes, for the SSE route. */
  subscribeChats(listener: () => void): () => void {
    this.chatListeners.add(listener);
    return () => {
      this.chatListeners.delete(listener);
    };
  }

  private emitChats(): void {
    // Taken before notifying, so a change made in this process is not reported
    // a second time by the poll that watches for changes made in another.
    this.chatsFingerprint = this.store.chatsFingerprint();
    for (const listener of this.chatListeners) {
      try {
        listener();
      } catch {
        // Same rule as drain: a broken SSE writer must not fail the call.
      }
    }
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
      this.releaseWork();
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
            chatId: this.work.chatId,
            since: this.work.since,
            agent: this.work.agent,
            tool: this.work.tool,
          }
        : null,
      activeChatId: this.store.ensureActiveChat().id,
      // The final lease looks identical on disk to a dead-lettered one — the
      // count is already at the cap the moment it is handed over. Only the
      // in-memory hold tells the two apart, so the message being worked right
      // now is never in the warning. It joins the list when that lease ends
      // unanswered, and not a second earlier.
      dropped: this.store
        .listDroppedUserSeqs()
        .filter((seq) => seq !== this.work?.seq),
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
   * passes with nothing to hand over, or once `signal` aborts.
   *
   * Null is a normal result, not an error: it exists so the agent's client sees
   * a completed tool call well inside its request timeout and can immediately
   * call again. The tool description tells the agent to do exactly that.
   *
   * A second agent parking does not take the open lease. The same agent
   * returning unanswered does: that is abandon, and the message goes back
   * on the queue (or to another waiter) rather than sitting delivered forever.
   */
  awaitUserTurn(
    options: {
      timeoutMs?: number;
      agent?: string | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<Turn | null> {
    const agent = options.agent ?? null;
    const signal = options.signal;
    // Asking is what makes a client a candidate for the next hand-off, so this
    // is the point where a second agent becomes real. An unnamed client counts
    // as one name: two anonymous clients are still two agents.
    this.askers.add(agent ?? "");
    this.touch(agent);
    if (this.sameHolder(agent)) this.releaseWork();
    if (this.closed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);

    // Anything typed before the agent got here is already on disk.
    const pending = this.store.claimNextUserTurn();
    if (pending) {
      if (signal?.aborted) {
        this.releaseLease(pending.seq, { revertAttempt: true });
        return Promise.resolve(null);
      }
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
        signal,
        resolve,
        timer: setTimeout(() => {
          this.drop(waiter);
          resolve(null);
        }, ms),
      };
      if (signal) {
        const onAbort = () => {
          this.drop(waiter);
          resolve(null);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
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

  /**
   * Pushes the chat list when another process has changed it.
   *
   * The turn drain covers everything that writes a row. Renaming does not
   * write one: a chat named through `chat_say` in the stdio MCP process would
   * otherwise sit under its old name in the rail until the user typed again or
   * reloaded, which is the whole feature failing quietly.
   */
  private drainChats(): void {
    if (this.chatListeners.size === 0) return;
    const now = this.store.chatsFingerprint();
    if (now === this.chatsFingerprint) return;
    this.emitChats();
  }

  /** Hands the oldest unclaimed user turn to the longest-waiting agent. */
  private handOff(): void {
    let handed = false;
    while (this.waiters.length > 0) {
      this.pruneAbortedWaiters();
      if (this.waiters.length === 0) break;
      const turn = this.store.claimNextUserTurn();
      if (!turn) break;
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.store.unclaimUserTurn(turn.seq, { revertAttempt: true });
        break;
      }
      clearTimeout(waiter.timer);
      waiter.cleanup?.();
      if (waiter.signal?.aborted) {
        this.store.unclaimUserTurn(turn.seq, { revertAttempt: true });
        waiter.resolve(null);
        continue;
      }
      this.beginWork(turn, waiter.agent);
      waiter.resolve(turn);
      handed = true;
    }
    if (handed) this.emitPresence();
  }

  /**
   * Ends the in-memory hold and writes that to disk. A released row is offered
   * to the next waiter; a dead-lettered one stays claimed for the UI warning.
   */
  releaseLease(seq: number, options: { revertAttempt?: boolean } = {}): void {
    if (this.work?.seq === seq) this.work = null;
    const result = this.store.unclaimUserTurn(seq, options);
    if (result === "released") this.handOff();
    else this.emitPresence();
  }

  private releaseWork(options: { revertAttempt?: boolean } = {}): void {
    if (!this.work) return;
    this.releaseLease(this.work.seq, options);
  }

  /**
   * The same client that holds the lease is asking for a message again.
   *
   * Compared on the literal name each caller gave, with no fall back to the
   * last name seen. Filling an unnamed caller in with `lastAgent` would let
   * any anonymous client match a named holder, take the lease away mid-answer,
   * and be handed the same message — the double-answer hole this lease exists
   * to close. An unnamed caller is the holder only when the holder is unnamed
   * too, which is the case where they really are the one client asking.
   */
  private sameHolder(agent: string | null): boolean {
    if (!this.work) return false;
    return (agent ?? "") === (this.work.agent ?? "");
  }

  private pruneAbortedWaiters(): void {
    const live: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (!waiter.signal?.aborted) {
        live.push(waiter);
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.cleanup?.();
      waiter.resolve(null);
    }
    if (live.length === this.waiters.length) return;
    this.waiters = live;
    this.maybeStopPoll();
    this.emitPresence();
  }

  /** One agent now holds one message. Ends at its next answer, or by expiry. */
  private beginWork(turn: Turn, agent: string | null): void {
    this.work = {
      seq: turn.seq,
      chatId: turn.chatId,
      since: new Date().toISOString(),
      // The hand-off is itself the first proof: the agent asked, and got one.
      provenAt: Date.now(),
      // The caller's own name, borrowed from nobody. `sameHolder` compares
      // against this, so stamping an unnamed claimant with `lastAgent` would
      // hand its lease to whoever that name belongs to.
      agent,
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
      this.drainChats();
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
    waiter.cleanup?.();
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
    if (stopped && wasOurs && this.work) this.releaseWork();
    else this.emitPresence();
  }

  /** Who new agent turns are stamped as: the launched CLI, else last initialize. */
  get clientName(): string | null {
    return this.launchedAgent ?? this.lastAgent;
  }

  /* ---- lifecycle -------------------------------------------------------- */

  setDriven(on: boolean): void {
    this.drivenFlag = on;
  }

  get driven(): boolean {
    return this.drivenFlag;
  }

  /**
   * Empties one chat and keeps it. Other chats are untouched.
   *
   * `chatId` is the pane naming what it is showing, for the same reason `post`
   * takes one: without it a clear empties whatever chat is active server-wide.
   * Callers must check `writable` first.
   */
  clear(chatId?: string): void {
    if (chatId && !this.writable(chatId)) throw new Error("no such chat");
    const id = chatId ?? this.store.ensureActiveChat().id;
    this.store.clearTurns(id);
    // The claimed message went with the history; nothing is being answered.
    if (this.work?.chatId === id) this.work = null;
    this.emitChats();
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
      waiter.cleanup?.();
      waiter.resolve(null);
    }
    this.listeners.clear();
    this.chatListeners.clear();
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
}

"use client";

import * as React from "react";
import {
  archiveAgentChat,
  clearAgentConversation,
  createAgentChat,
  decideAgentApproval,
  deleteAgentChat,
  getAgentState,
  listAgentChats,
  renameAgentChat,
  selectAgentChat,
  sendAgentMessage,
  stopAgentTurn,
  streamAgent,
  unarchiveAgentChat,
  undoAgentArchiveSweep,
  dismissAgentArchiveSweep,
  type AgentApproval,
  type AgentArchiveSweep,
} from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/client";
import { friendlyError } from "@/lib/api/errors";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type {
  AgentChat,
  AgentChatStorage,
  AgentPresence,
  AgentTurn,
} from "@/lib/types";

/**
 * The live agent conversation.
 *
 * Deliberately not a React Query cache. This is an append-only log fed by a
 * stream, not a resource that is fetched and invalidated: the two things Query
 * is good at — deduping fetches and refetching when stale — are the two things
 * this must not do.
 *
 * It is a provider rather than a plain hook because more than one place reads
 * it — the conversation pane and the sidebar's listening dot — and a hook per
 * consumer would open a second SSE connection per consumer.
 *
 * The stream stays open for the whole session, not only while the Agent view is
 * on screen. An answer that lands while the user is reading mail has to be
 * there when they switch back.
 */

const IDLE: AgentPresence = {
  waiting: 0,
  listening: false,
  lastSeenAt: null,
  lastAgent: null,
  launchedAgent: null,
  working: null,
  dropped: [],
};

/** Reads as "nothing stored yet" until the server has answered once. */
const NO_STORAGE: AgentChatStorage = {
  bytes: 0,
  budget: 0,
  chats: 0,
  archived: 0,
};

/**
 * A server built before the work signal existed sends presence without it.
 * Absence has to read as "nothing in flight" rather than as `undefined`, or the
 * pane would show a running indicator keyed off a field that is never there.
 */
function normalise(presence: AgentPresence): AgentPresence {
  return {
    ...presence,
    working: presence.working ?? null,
  };
}

/** Reconnect backoff. Capped low: this is a server on the same machine. */
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export type AgentConnection =
  | "connecting"
  | "live"
  | "offline"
  /** The server answered, and has no agent channel. Retrying cannot help. */
  | "unsupported";

export type AgentConversation = {
  turns: AgentTurn[];
  presence: AgentPresence;
  connection: AgentConnection;
  /**
   * User turns that will not be handed over again. A live lease is `working`,
   * not this: this is the dead-letter list, plus history rows still marked
   * delivered with no answer on an older server that cannot re-queue.
   *
   * `turn.delivered` is frozen at false on the live stream frame (written
   * before the hand-off). `presence.dropped` and `presence.working` cover
   * that gap for this session.
   */
  claimed: ReadonlySet<number>;
  /** Set when the last send or clear failed. Cleared on the next attempt. */
  error: string | null;
  sending: boolean;
  send: (text: string) => Promise<void>;
  /**
   * Ends the message the agent is answering, named by its seq.
   *
   * The caller names it rather than this reading `presence.working`, so what is
   * stopped is the run the user was looking at when they pressed the button and
   * not whatever was claimed by the time the request landed.
   */
  stop: (seq: number) => Promise<void>;
  stopping: boolean;
  clear: () => Promise<void>;
  /** Live chats, newest message first. Archived ones are fetched separately. */
  chats: AgentChat[];
  /** The chat on screen. Null until the server has answered once. */
  chat: AgentChat | null;
  storage: AgentChatStorage;
  /** Switching also makes the chat active on the server, so sends follow. */
  openChat: (id: string) => Promise<void>;
  newChat: () => Promise<void>;
  renameChat: (id: string, title: string) => Promise<void>;
  /** Puts a chat away with its messages. `unarchiveChat` is the undo. */
  archiveChat: (id: string) => Promise<void>;
  unarchiveChat: (id: string) => Promise<void>;
  /** Permanent, for a live chat or an archived one. Nothing undoes this. */
  removeChat: (id: string) => Promise<void>;
  /**
   * Actions an agent asked for and nobody has answered yet. Server-wide, not
   * per chat: a scheduled run belongs to no conversation, and a request the
   * user cannot see is a send that never happens.
   */
  approvals: AgentApproval[];
  /** Carries the action out, or drops it. Rejects with the reason it failed. */
  decideApproval: (id: string, decision: "approve" | "deny") => Promise<void>;
  /**
   * What launched agents archived, newest run first. Archiving is the one mail
   * write an agent makes unasked, on the grounds that it is reversible; this
   * is where reversing it is offered at the size the sweep actually was.
   */
  archiveSweeps: AgentArchiveSweep[];
  /** Moves one sweep back. Resolves with what actually made it. */
  undoArchiveSweep: (id: number) => Promise<{ restored: number; failed: number }>;
  /** Drops a sweep without moving messages back. */
  dismissArchiveSweep: (id: number) => Promise<void>;
};

/**
 * Merge by sequence number.
 *
 * History and the stream overlap: the stream is subscribed at one instant and
 * history is read at another, so the same turn can arrive twice and a turn
 * written in between can arrive out of order. Sorting on `seq` and dropping
 * duplicates makes the order of those two operations irrelevant.
 */
function merge(previous: AgentTurn[], incoming: AgentTurn[]): AgentTurn[] {
  if (incoming.length === 0) return previous;
  const bySeq = new Map(previous.map((turn) => [turn.seq, turn]));
  let changed = false;
  for (const turn of incoming) {
    const existing = bySeq.get(turn.seq);
    if (existing) {
      if (existing.delivered === turn.delivered && existing.replyTo === turn.replyTo) {
        continue;
      }
      bySeq.set(turn.seq, { ...existing, delivered: turn.delivered, replyTo: turn.replyTo });
      changed = true;
      continue;
    }
    bySeq.set(turn.seq, turn);
    changed = true;
  }
  if (!changed) return previous;
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** User turns that will not be offered again. */
function claimedIn(turns: AgentTurn[], presence: AgentPresence): number[] {
  // New servers name the dead-letter list. Do not also trust `delivered` on
  // a live turn: that flag is a lease, and a re-queue does not rewrite the
  // stream frame the client already stored.
  if (presence.dropped !== undefined) return [...presence.dropped];
  const workingSeq = presence.working?.seq;
  return turns
    .filter((turn) => turn.delivered && turn.seq !== workingSeq)
    .map((turn) => turn.seq);
}

const AgentContext = React.createContext<AgentConversation | null>(null);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const ctx = useApiCtx();
  /* The conversation belongs to one server and one token. Switching either is a
     different machine or a different identity, and the previous conversation
     must not be shown against it.

     The reset is a remount rather than an effect that clears four pieces of
     state. An effect would paint one frame of the old conversation against the
     new identity before it ran — which is exactly the frame that must not
     exist — and setState in an effect body is a cascading render besides.

     The key is JSON rather than the two values glued together. It used to
     be glued with a literal NUL byte, which worked and made git treat this
     whole file as binary — no readable diff, ever. JSON escapes both sides,
     so no base URL can be crafted to collide with a token boundary. */
  return (
    <AgentSession key={JSON.stringify([ctx.baseUrl, ctx.token])} ctx={ctx}>
      {children}
    </AgentSession>
  );
}

function AgentSession({
  ctx,
  children,
}: {
  ctx: { baseUrl: string; token: string };
  children: React.ReactNode;
}) {
  const enabled = ctx.baseUrl.length > 0 && ctx.token.length > 0;
  const [turns, setTurns] = React.useState<AgentTurn[]>([]);
  const [presence, setPresence] = React.useState<AgentPresence>(IDLE);
  const [connection, setConnection] = React.useState<AgentConnection>(
    enabled ? "connecting" : "offline",
  );
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [chats, setChats] = React.useState<AgentChat[]>([]);
  const [chat, setChat] = React.useState<AgentChat | null>(null);
  const [storage, setStorage] = React.useState<AgentChatStorage>(NO_STORAGE);
  const [approvals, setApprovals] = React.useState<AgentApproval[]>([]);
  const [archiveSweeps, setArchiveSweeps] = React.useState<AgentArchiveSweep[]>(
    [],
  );
  const claimed = React.useMemo(() => {
    const seqs = new Set<number>(claimedIn(turns, presence));
    return seqs;
  }, [turns, presence]);

  /* The chat on screen, readable from inside the long-lived stream loop.
     State cannot be: that effect is keyed on the connection, not on the
     selection, and re-running it on every switch would drop and rebuild the
     SSE connection each time somebody clicked a row in the rail. */
  const shown = React.useRef<string | null>(null);

  /**
   * Shows a chat and makes it the one the composer writes to.
   *
   * The turns are dropped before the fetch, not merged after it: `seq` is
   * global across chats, so a stale turn from the previous conversation would
   * sort cleanly into the middle of this one and look like it belonged.
   */
  const refresh = React.useCallback(
    async (id: string | null) => {
      shown.current = id;
      setTurns([]);
      const state = await getAgentState(ctx, undefined, id ?? undefined);
      // A second click landed while this was in flight. That switch owns the
      // pane now, and painting this answer would show the wrong conversation.
      if (shown.current !== id) return;
      shown.current = state.chat?.id ?? null;
      setChat(state.chat ?? null);
      setTurns(state.turns);
      setPresence(normalise(state.presence));
      setApprovals(state.approvals ?? []);
      setArchiveSweeps(state.archiveSweeps ?? []);
    },
    [ctx],
  );

  React.useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let attempt = 0;
    let stopped = false;

    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const run = async () => {
      while (!stopped) {
        try {
          // History first, then follow. Both merge on seq, so a turn written
          // between the two lands exactly once and in the right place.
          const state = await getAgentState(
            { ...ctx, signal: abort.signal },
            undefined,
            shown.current ?? undefined,
          );
          if (stopped) return;
          shown.current = state.chat?.id ?? null;
          setChat(state.chat ?? null);
          setTurns((prev) => merge(prev, state.turns));
          setPresence(normalise(state.presence));
          setApprovals(state.approvals ?? []);
          setArchiveSweeps(state.archiveSweeps ?? []);
          setConnection("live");
          attempt = 0;
          // Not awaited: the conversation must paint whether or not the rail's
          // list arrives, and a server without chats answers this with a 404.
          void listAgentChats({ ...ctx, signal: abort.signal })
            .then((list) => {
              if (stopped) return;
              setChats(list.chats);
              setStorage(list.storage);
            })
            .catch(() => {
              // Older server, or a list that failed once. The stream sends the
              // list again on the next change either way.
            });

          await streamAgent(
            { ...ctx, signal: abort.signal },
            {
              // A turn written in a chat the user is not looking at belongs to
              // that chat's history, not to this pane. The rail still learns
              // about it from the `chats` frame.
              turn: (turn) => {
                if (turn.chatId && turn.chatId !== shown.current) return;
                setTurns((prev) => merge(prev, [turn]));
              },
              presence: (next) => setPresence(normalise(next)),
              approvals: (pending) => setApprovals(pending),
              chats: (list) => {
                setChats(list.chats);
                setStorage(list.storage);
                const current = list.chats.find((row) => row.id === shown.current);
                if (current) {
                  setChat(current);
                  // The server trimmed this chat under a client that had
                  // streamed every turn. Those rows are gone; keeping them
                  // painted would put "older messages were dropped" above the
                  // messages it is talking about.
                  setTurns((prev) =>
                    prev.length > current.turns
                      ? prev.slice(prev.length - current.turns)
                      : prev,
                  );
                  return;
                }
                // The chat on screen is no longer a live chat: another window
                // archived or deleted it. Either way this pane is showing a
                // conversation the list no longer has, and the archived one
                // is read from the dialog rather than left open here. Fall
                // back to the active one.
                if (shown.current !== null) {
                  void refresh(null).catch(() => {
                    // The next frame, or the reconnect, asks again.
                  });
                }
              },
            },
          );
          if (stopped) return;
          // A clean end is a server restart or an intermediary timing the
          // connection out. Nothing is wrong; reconnect without saying so.
          await sleep(250);
        } catch (err) {
          if (stopped || abort.signal.aborted) return;
          if (err instanceof ApiError && err.status === 404) {
            // The chat this pane was showing is gone — deleted in another
            // window. Fall back to the active one rather than declaring the
            // whole channel missing.
            if (shown.current !== null) {
              shown.current = null;
              setTurns([]);
              continue;
            }
            // No chat asked for, so this build of the server has no agent
            // channel at all. Retrying forever would never fix that, and the
            // UI has a specific thing to say about it.
            setConnection("unsupported");
            return;
          }
          setConnection("offline");
          setPresence(IDLE);
          await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
          attempt += 1;
        }
      }
    };

    void run();
    return () => {
      stopped = true;
      abort.abort();
    };
    // `refresh` is stable on ctx, so this does not reconnect on a chat switch.
  }, [ctx, enabled, refresh]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setSending(true);
      setError(null);
      try {
        // The chat this pane is showing, not the one the server has active:
        // another window may have selected a different one since.
        const result = await sendAgentMessage(trimmed, ctx, shown.current ?? undefined);
        // The stream will deliver this turn too; merge() makes the duplicate
        // free, and painting it now is what keeps the composer feeling instant.
        setTurns((prev) => merge(prev, [result.turn]));
        setPresence(normalise(result.presence));
      } catch (err) {
        setError(friendlyError(err instanceof Error ? err.message : String(err)));
      } finally {
        setSending(false);
      }
    },
    [ctx],
  );

  /**
   * The presence in the reply is applied rather than waited for.
   *
   * The stream sends the same thing a moment later, but the button the user
   * pressed has to stop looking live on the click that pressed it — a Stop that
   * spins on for another frame reads as one that did not take.
   *
   * Only over the run it stopped, though. The killed turn frees the loop to
   * claim the next queued message, and that presence frame can arrive on the
   * stream before this reply is even parsed; writing this older snapshot over
   * it would paint an idle pane while an agent is genuinely working, until
   * whenever the next frame happens to arrive.
   */
  const stop = React.useCallback(
    async (seq: number) => {
      setStopping(true);
      setError(null);
      try {
        const result = await stopAgentTurn(seq, ctx);
        setPresence((prev) =>
          prev.working?.seq === seq ? normalise(result.presence) : prev,
        );
      } catch (err) {
        setError(friendlyError(err instanceof Error ? err.message : String(err)));
      } finally {
        setStopping(false);
      }
    },
    [ctx],
  );

  const clear = React.useCallback(async () => {
    setError(null);
    try {
      await clearAgentConversation(ctx, shown.current ?? undefined);
      setTurns([]);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    }
  }, [ctx]);

  const withChats = React.useCallback(
    async (run: () => Promise<void>) => {
      setError(null);
      try {
        await run();
        const list = await listAgentChats(ctx);
        setChats(list.chats);
        setStorage(list.storage);
      } catch (err) {
        setError(friendlyError(err instanceof Error ? err.message : String(err)));
      }
    },
    [ctx],
  );

  const openChat = React.useCallback(
    (id: string) =>
      withChats(async () => {
        await selectAgentChat(id, ctx);
        await refresh(id);
      }),
    [ctx, refresh, withChats],
  );

  const newChat = React.useCallback(
    () =>
      withChats(async () => {
        const created = await createAgentChat(ctx);
        await refresh(created.chat.id);
      }),
    [ctx, refresh, withChats],
  );

  const renameChat = React.useCallback(
    (id: string, title: string) =>
      withChats(async () => {
        await renameAgentChat(id, title, ctx);
        if (shown.current === id) setChat((prev) => (prev ? { ...prev, title } : prev));
      }),
    [ctx, withChats],
  );

  const archiveChat = React.useCallback(
    (id: string) =>
      withChats(async () => {
        await archiveAgentChat(id, ctx);
        // The messages are still there, but a chat the user has just put away
        // is not one to leave them staring at. The server has already moved on
        // to another one; ask it which.
        if (shown.current === id) await refresh(null);
      }),
    [ctx, refresh, withChats],
  );

  /* No refresh: unarchiving only puts the row back in the list, and the pane
     stays wherever the user left it. Opening the chat is a separate click. */
  const unarchiveChat = React.useCallback(
    (id: string) => withChats(() => unarchiveAgentChat(id, ctx).then(() => undefined)),
    [ctx, withChats],
  );

  const removeChat = React.useCallback(
    (id: string) =>
      withChats(async () => {
        await deleteAgentChat(id, ctx);
        if (shown.current === id) await refresh(null);
      }),
    [ctx, refresh, withChats],
  );

  /**
   * The answer is applied from the route's own reply rather than waiting for
   * the stream frame that follows it. The card has to leave the screen on the
   * click that dismissed it; a second click on a card still painted would come
   * back 409, which is correct and still reads as a bug.
   */
  const decideApproval = React.useCallback(
    async (id: string, decision: "approve" | "deny") => {
      setApprovals((prev) => prev.filter((row) => row.id !== id));
      try {
        const result = await decideAgentApproval(id, decision, ctx);
        setApprovals(result.pending);
      } catch (err) {
        // Put it back: nothing was sent, and a card that vanished on a failed
        // approval would read as one that went through.
        const state = await getAgentState(ctx, undefined, shown.current ?? undefined)
          .catch(() => null);
        if (state) setApprovals(state.approvals ?? []);
        throw err;
      }
    },
    [ctx],
  );

  const undoArchiveSweep = React.useCallback(
    async (id: number) => {
      const result = await undoAgentArchiveSweep(id, ctx);
      setArchiveSweeps(result.sweeps);
      return { restored: result.restored, failed: result.failed };
    },
    [ctx],
  );

  const dismissArchiveSweep = React.useCallback(
    async (id: number) => {
      const result = await dismissAgentArchiveSweep(id, ctx);
      setArchiveSweeps(result.sweeps);
    },
    [ctx],
  );

  const value = React.useMemo<AgentConversation>(
    () => ({
      turns,
      presence,
      connection,
      claimed,
      error,
      sending,
      send,
      stop,
      stopping,
      clear,
      chats,
      chat,
      storage,
      openChat,
      newChat,
      renameChat,
      archiveChat,
      unarchiveChat,
      removeChat,
      approvals,
      decideApproval,
      archiveSweeps,
      undoArchiveSweep,
      dismissArchiveSweep,
    }),
    [
      turns,
      presence,
      connection,
      claimed,
      error,
      sending,
      send,
      stop,
      stopping,
      clear,
      chats,
      chat,
      storage,
      openChat,
      newChat,
      renameChat,
      archiveChat,
      unarchiveChat,
      removeChat,
      approvals,
      decideApproval,
      archiveSweeps,
      undoArchiveSweep,
      dismissArchiveSweep,
    ],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentConversation {
  const value = React.useContext(AgentContext);
  if (!value) throw new Error("useAgent must be used inside <AgentProvider>");
  return value;
}

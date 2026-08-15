"use client";

import * as React from "react";
import {
  clearAgentConversation,
  getAgentState,
  sendAgentMessage,
  streamAgent,
} from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/client";
import { friendlyError } from "@/lib/api/errors";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { AgentPresence, AgentTurn } from "@/lib/types";

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
  clear: () => Promise<void>;
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
  const claimed = React.useMemo(() => {
    const seqs = new Set<number>(claimedIn(turns, presence));
    return seqs;
  }, [turns, presence]);

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
          const state = await getAgentState({ ...ctx, signal: abort.signal });
          if (stopped) return;
          setTurns((prev) => merge(prev, state.turns));
          setPresence(normalise(state.presence));
          setConnection("live");
          attempt = 0;

          await streamAgent(
            { ...ctx, signal: abort.signal },
            {
              turn: (turn) => setTurns((prev) => merge(prev, [turn])),
              presence: (next) => setPresence(normalise(next)),
            },
          );
          if (stopped) return;
          // A clean end is a server restart or an intermediary timing the
          // connection out. Nothing is wrong; reconnect without saying so.
          await sleep(250);
        } catch (err) {
          if (stopped || abort.signal.aborted) return;
          // A 404 means this build of the server has no agent channel at all.
          // Retrying every eight seconds forever would never fix that, and the
          // UI has a specific thing to say about it.
          if (err instanceof ApiError && err.status === 404) {
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
  }, [ctx, enabled]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setSending(true);
      setError(null);
      try {
        const result = await sendAgentMessage(trimmed, ctx);
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

  const clear = React.useCallback(async () => {
    setError(null);
    try {
      await clearAgentConversation(ctx);
      setTurns([]);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    }
  }, [ctx]);

  const value = React.useMemo<AgentConversation>(
    () => ({ turns, presence, connection, claimed, error, sending, send, clear }),
    [turns, presence, connection, claimed, error, sending, send, clear],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentConversation {
  const value = React.useContext(AgentContext);
  if (!value) throw new Error("useAgent must be used inside <AgentProvider>");
  return value;
}

"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelMeeting,
  createCalDavAccount,
  createMeeting,
  deleteCalendarAccount,
  getAgenda,
  getFreeSlots,
  listCalendarAccounts,
  listMeetings,
  refreshMeetingResponses,
  startGoogleCalendarAuth,
  testCalDavAccount,
  type CalDavAccountBody,
  type CreateMeetingBody,
  type GoogleCalendarStartBody,
} from "@/lib/api/endpoints";
import { localTimeZone, startOfDay } from "@/lib/format/calendar";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * The Calendar view's reads and its writes.
 *
 * Three collections, three keys: the accounts a person configured, the merged
 * agenda over a window, and the meetings Boxaide itself created. They are
 * separate because they come from separate endpoints and because a failing
 * calendar server must be able to break the agenda without emptying the other
 * two.
 */

export type AgendaRange = "today" | "7d" | "30d";

const RANGE_DAYS: Record<AgendaRange, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
};

/**
 * The window the agenda asks for, as calendar days in the viewer's local time.
 *
 * It starts at local midnight rather than "now" for two reasons: an event that
 * started ten minutes ago is still the one a person is looking for, and a start
 * that moved every render would be a new query key every render.
 */
export function agendaWindow(
  range: AgendaRange,
  now: Date = new Date(),
): { start: string; end: string } {
  const start = startOfDay(now);
  const end = new Date(start);
  end.setDate(end.getDate() + RANGE_DAYS[range]);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * The configured calendars, and the redirect URI the server hands Google.
 *
 * `data` is the whole response rather than the array: the Add-calendar dialog
 * reads `googleRedirectUri` off the same query the view already runs, so the
 * two are never one request apart from each other.
 */
export function useCalendarAccounts(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["calendar-accounts", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listCalendarAccounts({ ...ctx, signal }),
    staleTime: 30_000,
  });
}

/**
 * The agenda for one window. Keyed on the window's start as well as the range
 * name, so the query survives a re-render but not the clock passing midnight —
 * at which point "today" genuinely means a different day.
 */
export function useAgenda(range: AgendaRange, enabled = true) {
  const ctx = useApiCtx();
  const window = React.useMemo(() => agendaWindow(range), [range]);
  return useQuery({
    queryKey: ["calendar-agenda", ctx.baseUrl, ctx.token, range, window.start],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => getAgenda(window, { ...ctx, signal }),
    staleTime: 60_000,
  });
}

/** How far ahead the meeting form looks for a free time. */
const SUGGESTION_DAYS = 7;
const SUGGESTION_COUNT = 6;

/**
 * Times to offer in the meeting form.
 *
 * Re-runs when the duration changes, because a slot that fits 30 minutes need
 * not fit 90. Retries are off and failures are swallowed by the caller: a
 * suggestion strip that cannot load is one a person never knew about, and it
 * must not turn a working form into an error state.
 */
export function useFreeSlots(durationMinutes: number, enabled = true) {
  const ctx = useApiCtx();
  /* Read once per render rather than kept in state: it is a property of the
     machine, and the response echoes back the zone the server actually used,
     which is what the form quotes. */
  const timeZone = localTimeZone();
  /* Keyed on `enabled`, which is the dialog being open — NOT on mount. This
     app runs for days in a desktop window, and a window computed once at mount
     ages into the past, at which point every suggestion is behind the clock
     and the server has nothing to offer. Recomputing as the dialog opens means
     the window is as old as this opening, never older. */
  const window = React.useMemo(() => {
    const now = new Date();
    const end = new Date(startOfDay(now));
    end.setDate(end.getDate() + SUGGESTION_DAYS);
    // From NOW, not from midnight: a slot that started an hour ago is not a
    // time anybody can still book.
    return { start: now.toISOString(), end: end.toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return useQuery({
    queryKey: [
      "calendar-free-slots",
      ctx.baseUrl,
      ctx.token,
      durationMinutes,
      window.start,
      // In the key because it changes the answer: the same window in a
      // different zone is a different working day.
      timeZone,
    ],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) =>
      getFreeSlots(
        {
          durationMinutes,
          start: window.start,
          end: window.end,
          maxSlots: SUGGESTION_COUNT,
          timeZone,
        },
        { ...ctx, signal },
      ),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * The meetings Boxaide booked, and how current their guest responses are.
 *
 * `data` is the whole body: `meetings` comes straight out of the server's
 * store, while `refreshError` is the last background reply-scan's failure. The
 * two are separate on purpose — a mailbox that will not open must not empty
 * the list, it only means the responses beside it may be behind.
 */
export function useMeetings(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["calendar-meetings", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listMeetings({ ...ctx, signal }),
    staleTime: 30_000,
  });
}

/**
 * "Check for replies": read the mailboxes and calendars now.
 *
 * One pass over every meeting, so the count it returns is for the whole list
 * rather than the row the button sat on. The meetings are refetched afterwards
 * because the pass writes the new answers into the server's store — this
 * mutation's own result says how many moved, not which.
 */
export function useRefreshMeetingResponses() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => refreshMeetingResponses(ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["calendar-meetings"] });
    },
  });
}

/** A live CalDAV login server-side. Reports {ok}, and never writes anything. */
export function useTestCalDavAccount() {
  const ctx = useApiCtx();
  return useMutation({
    mutationFn: (body: CalDavAccountBody) => testCalDavAccount(body, ctx),
  });
}

export function useCreateCalDavAccount() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CalDavAccountBody) => createCalDavAccount(body, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["calendar-accounts"] });
      // A new calendar changes what the agenda contains, not only the list of
      // accounts under it.
      void queryClient.invalidateQueries({ queryKey: ["calendar-agenda"] });
    },
  });
}

export function useDeleteCalendarAccount() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => deleteCalendarAccount(accountId, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["calendar-accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["calendar-agenda"] });
    },
  });
}

/**
 * Starts Google's consent screen and returns its URL. Nothing is connected when
 * this resolves — the server finishes the handshake after the redirect, so the
 * account list is what tells you whether it worked.
 */
export function useStartGoogleCalendar() {
  const ctx = useApiCtx();
  return useMutation({
    mutationFn: (body: GoogleCalendarStartBody) =>
      startGoogleCalendarAuth(body, ctx),
  });
}

export function useCreateMeeting() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMeetingBody) => createMeeting(body, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["calendar-meetings"] });
      void queryClient.invalidateQueries({ queryKey: ["calendar-agenda"] });
      // The time just booked is no longer free. Without this the next dialog
      // would still offer it, from cache.
      void queryClient.invalidateQueries({ queryKey: ["calendar-free-slots"] });
    },
  });
}

export function useCancelMeeting() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (meetingId: string) => cancelMeeting(meetingId, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["calendar-meetings"] });
      void queryClient.invalidateQueries({ queryKey: ["calendar-agenda"] });
      // Cancelling hands the time back, so the suggestions are stale the other
      // way round.
      void queryClient.invalidateQueries({ queryKey: ["calendar-free-slots"] });
    },
  });
}

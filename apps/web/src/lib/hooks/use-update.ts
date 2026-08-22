"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  checkForUpdate,
  downloadUpdate,
  getUpdate,
  installUpdate,
} from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { UpdateState } from "@/lib/types";

/**
 * The rail's view of the updater.
 *
 * The server holds the state machine; this hook only decides how often to ask.
 * Nothing here infers a status — a download that fails, a check that finds
 * nothing and a version already installed all come back as `status`, and the
 * card renders that string. Two places deciding what "available" means is
 * exactly how a badge ends up outliving the update it announced.
 */

/** An update is waiting to be downloaded or installed: keep the card honest. */
const IDLE_POLL_MS = 10_000;
/**
 * Nothing to watch. UpdateCard is mounted in every view and calls this before
 * its own "draw nothing" early return, so a flat 10s polled 8,640 times a day
 * to render nothing at all.
 */
const QUIET_POLL_MS = 10 * 60_000;
/** A live progress bar. The request is loopback and the body is small. */
const ACTIVE_POLL_MS = 1_000;
/** Between "check" and its answer, which is one network round trip away. */
const CHECKING_POLL_MS = 2_000;

export type UpdateHandle = {
  /** Null until the first answer, and for a server that has no updater. */
  state: UpdateState | null;
  /** Presses the Check button: finds an update and starts downloading it. */
  check: () => void;
  /** Asks the same question without starting a download. */
  refresh: () => void;
  download: () => void;
  install: () => void;
  /** True while a check is running. */
  isChecking: boolean;
  /** True while a download mutation is in flight. */
  isDownloading: boolean;
  /** True while an install command is in flight. */
  isInstalling: boolean;
  /** True while any command is in flight, so a button can hold its press. */
  busy: boolean;
  /**
   * Why the last button press did nothing. Separate from `state.error`, which
   * is the server's own last failure: a 409 refusal never reaches that field,
   * and a button that answers a click with nothing at all reads as broken.
   */
  commandError: string | null;
};

/** A server built before `/api/update` existed, or one that will not answer it. */
function isMissingEndpoint(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 404 || error.status === 401)
  );
}

export function useUpdate(): UpdateHandle {
  const ctx = useApiCtx();
  const client = useQueryClient();
  const key = ["update", ctx.baseUrl, ctx.token];

  const query = useQuery({
    queryKey: key,
    enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => getUpdate({ ...ctx, signal }),
    // A server older than this endpoint answers 404 for good. Retrying it
    // every minute would be a permanent stream of failed requests behind a
    // sidebar that correctly shows nothing.
    retry: (count, error) => !isMissingEndpoint(error) && count < 1,
    refetchInterval: (q) => {
      // Only a server that has no updater stops the poll. Any other failure is
      // transient — a busy server, a dropped connection — and stopping on it
      // would freeze a download's progress bar at whatever percentage it had
      // reached, with no second request to ever unfreeze it.
      if (isMissingEndpoint(q.state.error)) return false;
      const status = q.state.data?.status;
      if (status === "downloading") return ACTIVE_POLL_MS;
      if (status === "checking") return CHECKING_POLL_MS;
      return status === "available" || status === "ready"
        ? IDLE_POLL_MS
        : QUIET_POLL_MS;
    },
    // Polling pauses on a hidden tab by default, which stops a download's
    // progress bar dead the moment the user switches app — and leaves it
    // frozen at whatever percentage it had reached when they come back. The
    // request is loopback and a few hundred bytes; keep it running.
    //
    // This stays `true`. It is a boolean, not a callback, so "background only
    // while downloading" cannot be expressed here — setting it false to save
    // idle polls silently reintroduced the frozen progress bar, because
    // queryObserver only fires the interval when this flag is set OR the window
    // is focused. The idle waste it was meant to fix is handled by
    // QUIET_POLL_MS above instead, which is the right lever: a hidden idle
    // window now polls every ten minutes rather than not at all.
    refetchIntervalInBackground: true,
    // The answer is worth refreshing when somebody comes back to the window;
    // it is the moment they are most likely to act on it.
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  /** Every command answers with the new state, so write it straight in. */
  const adopt = (state: UpdateState) => client.setQueryData(key, state);

  const resetErrors = () => {
    check.reset();
    refresh.reset();
    download.reset();
    install.reset();
  };

  const check = useMutation({
    mutationFn: () => checkForUpdate(ctx),
    onMutate: resetErrors,
    onSuccess: adopt,
  });
  // Same endpoint, no download. Used where the check was not a button press.
  const refresh = useMutation({
    mutationFn: () => checkForUpdate(ctx, { download: false }),
    onMutate: resetErrors,
    onSuccess: adopt,
  });
  const download = useMutation({
    mutationFn: () => downloadUpdate(ctx),
    onMutate: resetErrors,
    onSuccess: adopt,
  });
  const install = useMutation({
    mutationFn: () => installUpdate(ctx),
    onMutate: resetErrors,
    onSuccess: adopt,
  });

  const isChecking = check.isPending || refresh.isPending;
  const isDownloading = download.isPending;
  const isInstalling = install.isPending;
  const busy = isChecking || isDownloading || isInstalling;

  return {
    state: query.data ?? null,
    check: () => check.mutate(),
    refresh: () => refresh.mutate(),
    download: () => download.mutate(),
    install: () => install.mutate(),
    isChecking,
    isDownloading,
    isInstalling,
    busy,
    // Derived, not stored: a mutation clears its own error on the next press,
    // so the line goes away exactly when the user tries again.
    commandError: messageOf(
      download.error ?? install.error ?? check.error ?? refresh.error ?? null,
    ),
  };
}

/** The sentence to put under the button. Server text when there is any. */
function messageOf(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Does this state deserve a row in the rail?
 *
 * "Up to date" does not, and neither does a failed check on its own — the
 * rail states problems the user can act on, and a check that could not reach
 * GitHub is not one. What survives is an update that exists, a download in
 * flight, and one waiting for a restart.
 */
export function hasUpdateNews(state: UpdateState | null): state is UpdateState {
  if (!state) return false;
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "ready"
  );
}

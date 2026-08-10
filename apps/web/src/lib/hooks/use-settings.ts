"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_SETTINGS,
  readSettings,
  subscribeToSettings,
  writeSettings,
  type Settings,
} from "@/lib/settings";

/**
 * The settings snapshot, read from localStorage and kept referentially stable
 * so useSyncExternalStore does not loop. The server snapshot is the defaults,
 * which is what the static export prerenders; React swaps in the real values
 * right after hydration without a mismatch error.
 */
let cached: Settings = DEFAULT_SETTINGS;
let cachedKey = "";

function snapshot(): Settings {
  const next = readSettings();
  const key = JSON.stringify(next);
  if (key !== cachedKey) {
    cached = next;
    cachedKey = key;
  }
  return cached;
}

function serverSnapshot(): Settings {
  return DEFAULT_SETTINGS;
}

export function useSettings(): Settings {
  return React.useSyncExternalStore(
    subscribeToSettings,
    snapshot,
    serverSnapshot,
  );
}

/**
 * Write settings. Changing `baseUrl` or `token` clears the whole query cache
 * first — the cache holds someone's mailbox and must never be shown against a
 * different server or identity.
 */
export function useUpdateSettings(): (patch: Partial<Settings>) => void {
  const queryClient = useQueryClient();
  return React.useCallback(
    (patch: Partial<Settings>) => {
      const before = readSettings();
      const identityChanged =
        (patch.baseUrl !== undefined &&
          patch.baseUrl.trim().replace(/\/+$/, "") !== before.baseUrl) ||
        (patch.token !== undefined && patch.token !== before.token);
      if (identityChanged) queryClient.clear();
      writeSettings(patch);
    },
    [queryClient],
  );
}

/** Everything an endpoint call needs, memoised on the two identity fields. */
export function useApiCtx(): { baseUrl: string; token: string } {
  const settings = useSettings();
  return React.useMemo(
    () => ({ baseUrl: settings.baseUrl, token: settings.token }),
    [settings.baseUrl, settings.token],
  );
}

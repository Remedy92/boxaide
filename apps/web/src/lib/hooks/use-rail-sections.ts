"use client";

import * as React from "react";

/**
 * Which rail sections are open.
 *
 * Its own localStorage key rather than a field on Settings: Settings carries
 * the server identity and the preferences that change what the app IS, and it
 * is migrated across two old key namespaces. This is neither — it is where the
 * user last left a disclosure triangle, and losing it costs one click.
 *
 * Absent from the map means "use the section's own default", so a section added
 * later opens the way its author intended rather than the way an old saved map
 * happens to describe.
 */
const KEY = "boxaide.railSections";

type OpenMap = Record<string, boolean>;

function read(): OpenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: OpenMap = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") out[name] = value;
    }
    return out;
  } catch {
    // Unreadable or unparsable storage is the same as none.
    return {};
  }
}

/* One store for the whole app, read through useSyncExternalStore.
   Storage is an external system, and this is the shape React asks for when
   state lives in one: the snapshot is a cached object so repeated reads are
   referentially stable, and the server snapshot is empty so the prerendered
   HTML and the first client render agree. */
let snapshot: OpenMap = {};
let loaded = false;
const EMPTY: OpenMap = {};
const watchers = new Set<() => void>();

function getSnapshot(): OpenMap {
  if (!loaded) {
    snapshot = read();
    loaded = true;
  }
  return snapshot;
}

function getServerSnapshot(): OpenMap {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

function write(next: OpenMap): void {
  snapshot = next;
  loaded = true;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode, or a full quota. The session still works; the choice just
    // does not survive a reload.
  }
  for (const listener of watchers) listener();
}

export type RailSections = {
  isOpen: (id: string, fallback: boolean) => boolean;
  toggle: (id: string, fallback: boolean) => void;
};

export function useRailSections(): RailSections {
  const open = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const isOpen = React.useCallback(
    (id: string, fallback: boolean) => open[id] ?? fallback,
    [open],
  );

  const toggle = React.useCallback((id: string, fallback: boolean) => {
    const current = getSnapshot();
    write({ ...current, [id]: !(current[id] ?? fallback) });
  }, []);

  return React.useMemo(() => ({ isOpen, toggle }), [isOpen, toggle]);
}

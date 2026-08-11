/**
 * Where the base URL and the bearer token live: localStorage, and nowhere else.
 * No cookies, no server, no env var carries a secret. Every accessor is guarded
 * for `typeof window === "undefined"` so the static export prerender does not
 * crash.
 *
 * Rules that callers must honour (§2.6):
 *  - `baseUrl` and `token` are part of every TanStack query key, so changing
 *    either refetches instead of showing another server's mail.
 *  - Changing `baseUrl` or `token` calls queryClient.clear() before refetching.
 *    The cache holds someone's mailbox; purge it explicitly.
 *  - The token is never logged, never put in a query string, never sent to any
 *    origin other than `baseUrl`.
 */

import { DEFAULT_API_BASE, MAX_RECENT_COMMANDS } from "@/lib/constants";

export type Density = "comfortable" | "compact";

export type Settings = {
  baseUrl: string;
  token: string;
  density: Density;
  railCollapsed: boolean;
  recentCommands: string[];
  /**
   * True once the first-run wizard has been finished or skipped. It is a UI
   * preference, not a claim about the server: a fresh browser pointed at a
   * working server still gets the wizard, because it is that browser that has
   * no token.
   */
  onboarded: boolean;
};

/**
 * The bundled web/ UI stored the token under `mailmux_token`. The Next build
 * replaces that UI at the same origin, so without a one-time read every
 * self-hosted user would silently lose their saved token on upgrade.
 */
const LEGACY_TOKEN_KEY = "mailmux_token";

export const SETTINGS_KEYS = {
  baseUrl: "mailmux.baseUrl",
  token: "mailmux.token",
  density: "mailmux.density",
  railCollapsed: "mailmux.railCollapsed",
  recentCommands: "mailmux.recentCommands",
  onboarded: "mailmux.onboarded",
  /** Owned by next-themes, listed here so the key namespace is documented. */
  theme: "mailmux.theme",
} as const;

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: DEFAULT_API_BASE,
  token: "",
  density: "comfortable",
  railCollapsed: false,
  recentCommands: [],
  onboarded: false,
};

/** Fired on the window after any write, so same-tab listeners can react. */
export const SETTINGS_EVENT = "mailmux:settings";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Safari in private mode and any browser with storage blocked.
    return null;
  }
}

function readString(key: string): string | null {
  return storage()?.getItem(key) ?? null;
}

/** Trailing slashes are stripped so `${base}${path}` never doubles up. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Must parse as a URL with an http: or https: protocol (§6.7). */
export function isValidBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** `host:port` for the rail footer and the unreachable copy. */
export function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function parseRecentCommands(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, MAX_RECENT_COMMANDS);
  } catch {
    return [];
  }
}

/**
 * Read every setting synchronously. Safe to call during the first client
 * render; returns the defaults on the server so the prerendered HTML and the
 * first client render agree.
 */
export function readSettings(): Settings {
  if (!storage()) return { ...DEFAULT_SETTINGS };
  const stored = readString(SETTINGS_KEYS.baseUrl);
  const token = readString(SETTINGS_KEYS.token) ?? readString(LEGACY_TOKEN_KEY);
  const density = readString(SETTINGS_KEYS.density);
  const railCollapsed = readString(SETTINGS_KEYS.railCollapsed);
  /* Validated on the way OUT, not only on the way in. isValidBaseUrl runs in
     the settings dialog, but localStorage is writable by anything with script
     access to this origin, and the value is rendered as an href by the
     mixed-content recovery block — a stored `javascript:` URL would otherwise
     survive normalizeBaseUrl and execute on click. */
  const baseUrl =
    stored === null
      ? DEFAULT_SETTINGS.baseUrl
      : // An empty string is a real state — §7.1, "no server URL set" — and is
        // never rendered as an href, so it is kept as written.
        stored.trim() === "" || isValidBaseUrl(stored)
        ? normalizeBaseUrl(stored)
        : DEFAULT_SETTINGS.baseUrl;
  return {
    baseUrl,
    token: token ?? DEFAULT_SETTINGS.token,
    density: density === "compact" ? "compact" : "comfortable",
    railCollapsed: railCollapsed === "1",
    recentCommands: parseRecentCommands(readString(SETTINGS_KEYS.recentCommands)),
    /* A pre-existing token means this browser was already set up before the
       wizard shipped. Treating that as "onboarded" is the difference between an
       upgrade and being sent back to a first-run screen. */
    onboarded:
      readString(SETTINGS_KEYS.onboarded) === "1" ||
      (token ?? "").length > 0,
  };
}

function writeString(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Quota or a blocked store: the app keeps working, it just does not persist.
  }
}

/** Write a subset of the settings and notify same-tab listeners. */
export function writeSettings(patch: Partial<Settings>): Settings {
  if (patch.baseUrl !== undefined) {
    writeString(SETTINGS_KEYS.baseUrl, normalizeBaseUrl(patch.baseUrl));
  }
  if (patch.token !== undefined) writeString(SETTINGS_KEYS.token, patch.token);
  if (patch.density !== undefined) {
    writeString(SETTINGS_KEYS.density, patch.density);
  }
  if (patch.railCollapsed !== undefined) {
    writeString(SETTINGS_KEYS.railCollapsed, patch.railCollapsed ? "1" : "0");
  }
  if (patch.onboarded !== undefined) {
    writeString(SETTINGS_KEYS.onboarded, patch.onboarded ? "1" : "0");
  }
  if (patch.recentCommands !== undefined) {
    writeString(
      SETTINGS_KEYS.recentCommands,
      JSON.stringify(patch.recentCommands.slice(0, MAX_RECENT_COMMANDS)),
    );
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SETTINGS_EVENT));
  }
  return readSettings();
}

/** Move a command to the front of the recent list, capped at 8. */
export function rememberCommand(id: string, current: string[]): string[] {
  const next = [id, ...current.filter((entry) => entry !== id)].slice(
    0,
    MAX_RECENT_COMMANDS,
  );
  writeSettings({ recentCommands: next });
  return next;
}

/**
 * Subscribe to settings changes from this tab (SETTINGS_EVENT) and from other
 * tabs (the native `storage` event). Returns an unsubscribe function.
 */
export function subscribeToSettings(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("mailmux.")) onChange();
  };
  window.addEventListener(SETTINGS_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

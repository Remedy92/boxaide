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
  /**
   * Model id the launcher should pass on the next agent start. Empty string
   * means the CLI's own default. The server validates it against its own
   * registry, so a stale stored id fails loudly instead of launching wrong.
   */
  agentModel: string;
};

/**
 * Pre-rename keys. Reads fall back Sley then Mailmux so an upgrade does not
 * drop a saved token or preference. Writes go only to `boxaide.*`.
 */
export const LEGACY_TOKEN_KEY = "mailmux_token";

const SLEY_SETTINGS_KEYS = {
  baseUrl: "sley.baseUrl",
  token: "sley.token",
  density: "sley.density",
  railCollapsed: "sley.railCollapsed",
  recentCommands: "sley.recentCommands",
  onboarded: "sley.onboarded",
  agentModel: "sley.agentModel",
  theme: "sley.theme",
} as const;

const LEGACY_SETTINGS_KEYS = {
  baseUrl: "mailmux.baseUrl",
  token: "mailmux.token",
  density: "mailmux.density",
  railCollapsed: "mailmux.railCollapsed",
  recentCommands: "mailmux.recentCommands",
  onboarded: "mailmux.onboarded",
  agentModel: "mailmux.agentModel",
  theme: "mailmux.theme",
} as const;

export const SETTINGS_KEYS = {
  baseUrl: "boxaide.baseUrl",
  token: "boxaide.token",
  density: "boxaide.density",
  railCollapsed: "boxaide.railCollapsed",
  recentCommands: "boxaide.recentCommands",
  onboarded: "boxaide.onboarded",
  agentModel: "boxaide.agentModel",
  /** Owned by next-themes, listed here so the key namespace is documented. */
  theme: "boxaide.theme",
} as const;

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: DEFAULT_API_BASE,
  token: "",
  density: "comfortable",
  railCollapsed: false,
  recentCommands: [],
  onboarded: false,
  agentModel: "",
};

/** Fired on the window after any write, so same-tab listeners can react. */
export const SETTINGS_EVENT = "boxaide:settings";

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

/** Prefer `boxaide.*`, then `sley.*`, then `mailmux.*`. */
function readPref(key: keyof typeof SETTINGS_KEYS): string | null {
  return (
    readString(SETTINGS_KEYS[key]) ??
    readString(SLEY_SETTINGS_KEYS[key]) ??
    readString(LEGACY_SETTINGS_KEYS[key])
  );
}

/**
 * Copy `sley.theme` or `mailmux.theme` onto `boxaide.theme` once. next-themes
 * only reads its `storageKey`, so a fallback that lives only in this module
 * would never run.
 */
export function adoptLegacyTheme(): void {
  const store = storage();
  if (!store) return;
  if (store.getItem(SETTINGS_KEYS.theme) !== null) return;
  const prev =
    store.getItem(SLEY_SETTINGS_KEYS.theme) ??
    store.getItem(LEGACY_SETTINGS_KEYS.theme);
  if (prev !== null) {
    try {
      store.setItem(SETTINGS_KEYS.theme, prev);
    } catch {
      // Quota or a blocked store: the app keeps working without the old pick.
    }
  }
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
  const stored = readPref("baseUrl");
  const token =
    readPref("token") ?? readString(LEGACY_TOKEN_KEY);
  const density = readPref("density");
  const railCollapsed = readPref("railCollapsed");
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
    recentCommands: parseRecentCommands(readPref("recentCommands")),
    /* A pre-existing token means this browser was already set up before the
       wizard shipped. Treating that as "onboarded" is the difference between an
       upgrade and being sent back to a first-run screen. */
    onboarded:
      readPref("onboarded") === "1" ||
      (token ?? "").length > 0,
    agentModel: readPref("agentModel") ?? "",
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
  if (patch.agentModel !== undefined) {
    writeString(SETTINGS_KEYS.agentModel, patch.agentModel);
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
    if (
      event.key === null ||
      event.key.startsWith("boxaide.") ||
      event.key.startsWith("sley.") ||
      event.key.startsWith("mailmux.")
    ) {
      onChange();
    }
  };
  window.addEventListener(SETTINGS_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

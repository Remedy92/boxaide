"use client";

import * as React from "react";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { useSettings, useUpdateSettings } from "@/lib/hooks/use-settings";
import { readSettings, type Density } from "@/lib/settings";
import type { MailAccountMeta } from "@/lib/types";

/**
 * The one place cross-pane UI state lives: which mailbox and folder the list is
 * showing, which message the reader has, which overlay is open, and what the
 * composer should open prefilled with.
 *
 * It is a context rather than props because the rail, the list header, the
 * reader action bar, the keyboard map and the command palette all drive the
 * same four filters. It holds no mail data — every byte of that comes from
 * TanStack Query, keyed on the base URL and the token.
 */

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export type ComposeSeed = {
  /** Fresh on every open, so the compose form can be keyed on it and needs no
      state-syncing effect. */
  nonce: number;
  mode: ComposeMode;
  /** Account alias the message is sent from. */
  account?: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  /** True when the source message carried no Message-ID (§6.4). */
  threadingUnavailable?: boolean;
  /**
   * Set when the composer was opened FROM a stored draft. On a successful send
   * the composer deletes that draft, so "move to compose and send" does not
   * leave the unsent copy sitting in the Drafts folder.
   */
  draftId?: string;
  draftAccountId?: string;
};

export type DialogName =
  | "connect"
  | "compose"
  | "settings"
  | "shortcuts"
  | "palette"
  | "capabilities"
  | "agent";

export type SettingsFocus = "baseUrl" | "token" | null;

/** Which pane the list is showing. Drafts are a separate collection, not a folder. */
export type View = "mail" | "drafts";

export type Selection = { accountId: string; messageId: string };

/** A draft's id has the same accountId:folder:uid shape as a message id. */
export type DraftSelection = { accountId: string; draftId: string };

export type ReplyRequest = { mode: Exclude<ComposeMode, "new">; nonce: number };

/** Which page the command palette opens on. `g f` asks for "folders". */
export type PalettePage = "root" | "folders";

type AppStateValue = {
  /* filters */
  account: string;
  setAccount: (value: string) => void;
  folder: string | undefined;
  setFolder: (value: string | undefined) => void;
  unreadOnly: boolean;
  setUnreadOnly: (value: boolean) => void;
  /** Stable — safe to hold in the shared value; see useSearchQuery for the text. */
  setRawQuery: (value: string) => void;
  /** Clears a non-empty search and reports whether it had anything to clear. */
  clearSearch: () => boolean;
  /** Debounced by 300ms; this is what the request uses. */
  query: string;
  /** True while a search is running. Search ignores `folder` and `unread`. */
  searching: boolean;

  /* view */
  view: View;
  setView: (value: View) => void;

  /* selection */
  selected: Selection | null;
  select: (value: Selection) => void;
  clearSelection: () => void;
  /** Non-null only while the hash names a draft. Mutually exclusive with `selected`. */
  selectedDraft: DraftSelection | null;
  selectDraft: (value: DraftSelection) => void;

  /* layout */
  density: Density;
  toggleDensity: () => void;
  railCollapsed: boolean;
  setRailCollapsed: (value: boolean) => void;
  /** Below 760px there is no rail column, so this drives the sheet instead. */
  toggleRail: () => void;
  railSheetOpen: boolean;
  setRailSheetOpen: (value: boolean) => void;
  /** < 760px — one pane at a time. */
  narrow: boolean;
  /** 760–1099px — the rail collapses to icons. */
  medium: boolean;
  /** The rail is showing as an overlay above the list at the medium breakpoint. */
  railOverlay: boolean;
  setRailOverlay: (value: boolean) => void;
  reducedMotion: boolean;

  /* overlays */
  dialog: DialogName | null;
  openDialog: (name: DialogName) => void;
  closeDialog: () => void;
  /** The page the palette should mount on. Reset to "root" on close. */
  palettePage: PalettePage;
  openPalette: (page?: PalettePage) => void;
  /** The mailbox a Remove confirmation is open for, from the rail or the palette. */
  removalTarget: MailAccountMeta | null;
  requestRemoveAccount: (account: MailAccountMeta) => void;
  clearRemovalTarget: () => void;
  settingsFocus: SettingsFocus;
  /** Non-null ⇒ the settings dialog runs its connection test on open. */
  settingsAutoTest: number | null;
  openSettings: (focus?: SettingsFocus, autoTest?: boolean) => void;

  /* first run */
  /** True while the full-screen setup wizard owns the viewport. */
  wizardOpen: boolean;
  openWizard: () => void;
  /** Marks this browser set up and returns to the inbox. */
  finishWizard: () => void;

  /* composer */
  composeSeed: ComposeSeed | null;
  openCompose: (seed?: Partial<ComposeSeed>) => void;
  /** Keyboard r / a / f: ask the reader to expand its inline composer. */
  replyRequest: ReplyRequest | null;
  requestReply: (mode: Exclude<ComposeMode, "new">) => void;
  clearReplyRequest: () => void;

  /* shared focus targets. The ref object itself is deliberately NOT exposed:
     handing a ref across a context makes every consumer a render-time ref
     reader. Consumers register their node instead. */
  registerSearchInput: (node: HTMLInputElement | null) => void;
  focusSearch: () => void;
};

const AppStateContext = React.createContext<AppStateValue | null>(null);

/**
 * The raw search text lives in its own context on purpose. It changes on every
 * keystroke, and every field above changes at most on a click — folding the two
 * together would put a new object into AppStateContext per character and
 * re-render the rail, the reader and all 200 rows while the user types. Only
 * the list header reads this.
 */
const SearchQueryContext = React.createContext<string>("");

export function useSearchQuery(): string {
  return React.useContext(SearchQueryContext);
}

const HASH_PATTERN = /^#\/a\/([^/]+)\/m\/(.+)$/;
/** Same shape, `d` instead of `m`. One hash, so a draft and a message can
    never both be open — which is also true of the reading pane. */
const DRAFT_HASH_PATTERN = /^#\/a\/([^/]+)\/d\/(.+)$/;

/**
 * history.replaceState fires neither `hashchange` nor `popstate`, so the store
 * below would never see a programmatic selection. This event closes that gap.
 */
const HASH_EVENT = "mailmux:hash";

function subscribeToHash(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  window.addEventListener(HASH_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener(HASH_EVENT, onChange);
  };
}

function readHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/** The static export prerenders with no hash, which is also the empty state. */
function readServerHash(): string {
  return "";
}

function selectionFromHash(hash: string): Selection | null {
  const match = HASH_PATTERN.exec(hash);
  if (!match) return null;
  try {
    return {
      accountId: decodeURIComponent(match[1]),
      messageId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function draftFromHash(hash: string): DraftSelection | null {
  const match = DRAFT_HASH_PATTERN.exec(hash);
  if (!match) return null;
  try {
    return {
      accountId: decodeURIComponent(match[1]),
      draftId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function hashFor(selection: Selection): string {
  return `#/a/${encodeURIComponent(selection.accountId)}/m/${encodeURIComponent(
    selection.messageId,
  )}`;
}

function draftHashFor(selection: DraftSelection): string {
  return `#/a/${encodeURIComponent(selection.accountId)}/d/${encodeURIComponent(
    selection.draftId,
  )}`;
}

/** "Has this hydrated yet?" as an external store, so it costs no extra render. */
const NO_SUBSCRIBE = () => () => {};
const CLIENT_MOUNTED = () => true;
const SERVER_MOUNTED = () => false;

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  const [account, setAccountState] = React.useState("all");
  const [view, setViewState] = React.useState<View>("mail");
  const [folder, setFolder] = React.useState<string | undefined>(undefined);
  const [unreadOnly, setUnreadOnlyState] = React.useState(false);
  const [rawQuery, setRawQuery] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [dialog, setDialog] = React.useState<DialogName | null>(null);
  const [palettePage, setPalettePage] = React.useState<PalettePage>("root");
  const [removalTarget, setRemovalTarget] =
    React.useState<MailAccountMeta | null>(null);
  const [railSheetOpen, setRailSheetOpen] = React.useState(false);
  const [settingsFocus, setSettingsFocus] = React.useState<SettingsFocus>(null);
  const [settingsAutoTest, setSettingsAutoTest] = React.useState<number | null>(null);
  const [composeSeed, setComposeSeed] = React.useState<ComposeSeed | null>(null);
  const [replyRequest, setReplyRequest] = React.useState<ReplyRequest | null>(null);
  const [narrow, setNarrow] = React.useState(false);
  const [medium, setMedium] = React.useState(false);
  const [railOverlay, setRailOverlay] = React.useState(false);
  const [reducedMotion, setReducedMotion] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  /* Selection is derived from the URL hash rather than mirrored into state, so
     there is one source of truth and no effect keeping two of them in step. */
  const hash = React.useSyncExternalStore(
    subscribeToHash,
    readHash,
    readServerHash,
  );
  const selected = React.useMemo(() => selectionFromHash(hash), [hash]);
  const selectedDraft = React.useMemo(() => draftFromHash(hash), [hash]);

  /* The browser's own Back button pops the pushed entry without going through
     clearSelection, so the flag has to follow the hash, not only our callers.
     Declared below with the rest of the hash plumbing; assigned here. */

  /* ---- search debounce (§6.3) ---------------------------------------- */
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  /* Escape and the reader both need to know whether a search is on without
     subscribing to every keystroke, so the text is mirrored into a ref. */
  const rawQueryRef = React.useRef(rawQuery);
  React.useEffect(() => {
    rawQueryRef.current = rawQuery;
  }, [rawQuery]);

  const clearSearch = React.useCallback(() => {
    if (!rawQueryRef.current) return false;
    setRawQuery("");
    return true;
  }, []);

  /* ---- breakpoints. Two, and they snap (§5.3) ------------------------ */
  React.useEffect(() => {
    const narrowQuery = window.matchMedia("(max-width: 759px)");
    const mediumQuery = window.matchMedia(
      "(min-width: 760px) and (max-width: 1099px)",
    );
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setNarrow(narrowQuery.matches);
      setMedium(mediumQuery.matches);
      setReducedMotion(motionQuery.matches);
      if (!mediumQuery.matches) setRailOverlay(false);
    };
    sync();
    narrowQuery.addEventListener("change", sync);
    mediumQuery.addEventListener("change", sync);
    motionQuery.addEventListener("change", sync);
    return () => {
      narrowQuery.removeEventListener("change", sync);
      mediumQuery.removeEventListener("change", sync);
      motionQuery.removeEventListener("change", sync);
    };
  }, []);

  /* ---- selection ⇄ URL hash (§2.7) ----------------------------------- */
  /**
   * True only while the current selection was pushed as its own history entry.
   * clearSelection consults it before calling history.back(): a selection made
   * at desktop width is a replaceState, so if the window is then narrowed,
   * going "back" would leave the app entirely instead of returning to the list.
   */
  const pushedSelection = React.useRef(false);

  React.useEffect(() => {
    // No hash ⇒ nothing of ours is on the stack, however it got popped.
    if (!selected && !selectedDraft) pushedSelection.current = false;
  }, [selected, selectedDraft]);

  const select = React.useCallback(
    (value: Selection) => {
      // A pending r / a / f belongs to the message it was pressed on.
      setReplyRequest(null);
      const next = hashFor(value);
      if (typeof window === "undefined" || window.location.hash === next) return;
      // Below 760px the reader replaces the list, so Back must return to it.
      if (narrow && !pushedSelection.current) {
        window.history.pushState(null, "", next);
        pushedSelection.current = true;
      } else {
        window.history.replaceState(null, "", next);
      }
      window.dispatchEvent(new Event(HASH_EVENT));
    },
    [narrow],
  );

  const selectDraft = React.useCallback(
    (value: DraftSelection) => {
      setReplyRequest(null);
      const next = draftHashFor(value);
      if (typeof window === "undefined" || window.location.hash === next) return;
      if (narrow && !pushedSelection.current) {
        window.history.pushState(null, "", next);
        pushedSelection.current = true;
      } else {
        window.history.replaceState(null, "", next);
      }
      window.dispatchEvent(new Event(HASH_EVENT));
    },
    [narrow],
  );

  const clearSelection = React.useCallback(() => {
    setReplyRequest(null);
    if (typeof window === "undefined") return;
    // Only pop an entry this app actually pushed. Otherwise back() would walk
    // off the app — the entry behind a replaceState selection is whatever page
    // the user was on before mailmux.
    if (narrow && window.location.hash && pushedSelection.current) {
      pushedSelection.current = false;
      window.history.back();
      return;
    }
    pushedSelection.current = false;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    window.dispatchEvent(new Event(HASH_EVENT));
  }, [narrow]);

  /* ---- filters -------------------------------------------------------- */
  const setAccount = React.useCallback((value: string) => {
    setAccountState(value);
    // Folders are per mailbox, so the folder filter cannot survive the change.
    setFolder(undefined);
  }, []);

  /* Switching between mail and drafts drops the open item: a message id and a
     draft id name different collections, and leaving one in the hash would put
     the reading pane on something the list no longer contains. */
  const clearSelectionRefForView = React.useRef(clearSelection);
  React.useEffect(() => {
    clearSelectionRefForView.current = clearSelection;
  }, [clearSelection]);

  const viewRef = React.useRef(view);
  React.useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const setView = React.useCallback((next: View) => {
    if (viewRef.current === next) return;
    viewRef.current = next;
    clearSelectionRefForView.current();
    setViewState(next);
  }, []);

  /**
   * GET /api/messages/search takes no `unread` parameter (routes.ts never
   * forwards one), so a lit unread toggle over a search would be a control
   * that changes nothing. Turning it on therefore leaves the search — visibly,
   * because the box empties — rather than pretending to filter the results.
   * One rule for the header toggle, the palette row and `g u` alike.
   */
  const setUnreadOnly = React.useCallback((value: boolean) => {
    if (value && rawQueryRef.current) setRawQuery("");
    setUnreadOnlyState(value);
  }, []);

  /* ---- layout --------------------------------------------------------- */
  const toggleDensity = React.useCallback(() => {
    updateSettings({
      density: settings.density === "compact" ? "comfortable" : "compact",
    });
  }, [settings.density, updateSettings]);

  const setRailCollapsed = React.useCallback(
    (value: boolean) => updateSettings({ railCollapsed: value }),
    [updateSettings],
  );

  const toggleRail = React.useCallback(() => {
    // Below 760px the rail column is not rendered at all — the only rail
    // surface is the sheet, so `[` and the palette's "Toggle sidebar" have to
    // drive that or they are no-ops on every phone-width layout.
    if (narrow) {
      setRailSheetOpen((open) => !open);
      return;
    }
    if (medium) {
      setRailOverlay((open) => !open);
      return;
    }
    updateSettings({ railCollapsed: !settings.railCollapsed });
  }, [medium, narrow, settings.railCollapsed, updateSettings]);

  /* ---- overlays ------------------------------------------------------- */
  const openDialog = React.useCallback((name: DialogName) => {
    setDialog(name);
    if (name === "palette") setPalettePage("root");
    if (name !== "settings") {
      setSettingsFocus(null);
      setSettingsAutoTest(null);
    }
  }, []);

  const openPalette = React.useCallback((page: PalettePage = "root") => {
    setPalettePage(page);
    setSettingsFocus(null);
    setSettingsAutoTest(null);
    setDialog("palette");
  }, []);

  const closeDialog = React.useCallback(() => {
    setDialog(null);
    setPalettePage("root");
    setSettingsFocus(null);
    setSettingsAutoTest(null);
  }, []);

  const requestRemoveAccount = React.useCallback(
    (account: MailAccountMeta) => setRemovalTarget(account),
    [],
  );
  const clearRemovalTarget = React.useCallback(() => setRemovalTarget(null), []);

  const openSettings = React.useCallback(
    (focus: SettingsFocus = null, autoTest = false) => {
      setSettingsFocus(focus);
      // A nonce rather than a boolean: asking twice in a row must run the test
      // twice, and a boolean that is already true would not change.
      setSettingsAutoTest(autoTest ? Date.now() : null);
      setDialog("settings");
    },
    [],
  );

  const openCompose = React.useCallback((seed?: Partial<ComposeSeed>) => {
    setComposeSeed({
      nonce: Date.now(),
      mode: seed?.mode ?? "new",
      account: seed?.account,
      to: seed?.to ?? "",
      cc: seed?.cc ?? "",
      bcc: seed?.bcc ?? "",
      subject: seed?.subject ?? "",
      text: seed?.text ?? "",
      inReplyTo: seed?.inReplyTo,
      references: seed?.references,
      threadingUnavailable: seed?.threadingUnavailable,
      draftId: seed?.draftId,
      draftAccountId: seed?.draftAccountId,
    });
    setDialog("compose");
  }, []);

  /* ---- first run ------------------------------------------------------ */
  /* Gated on mount so the prerendered HTML — which reads the DEFAULT settings,
     where `onboarded` is false — never paints the wizard over a browser that is
     already set up. */
  const mounted = React.useSyncExternalStore(
    NO_SUBSCRIBE,
    CLIENT_MOUNTED,
    SERVER_MOUNTED,
  );
  /* Captured once, on this browser's first render, and never re-read.
     `onboarded` is true as soon as a token exists, so reading it live would
     close the wizard the instant step one saved one — the user would never see
     step two. What decides whether the wizard opens is the state the browser
     arrived in; what closes it is finishing or skipping it. */
  const [arrivedOnboarded] = React.useState(() => readSettings().onboarded);
  const [wizardForced, setWizardForced] = React.useState(false);
  const [wizardDone, setWizardDone] = React.useState(false);
  const wizardOpen =
    mounted && !wizardDone && (wizardForced || !arrivedOnboarded);

  const openWizard = React.useCallback(() => {
    setWizardDone(false);
    setWizardForced(true);
  }, []);
  const finishWizard = React.useCallback(() => {
    setWizardForced(false);
    setWizardDone(true);
    updateSettings({ onboarded: true });
  }, [updateSettings]);

  const requestReply = React.useCallback(
    (mode: Exclude<ComposeMode, "new">) =>
      setReplyRequest({ mode, nonce: Date.now() }),
    [],
  );
  const clearReplyRequest = React.useCallback(() => setReplyRequest(null), []);

  /* Below 760px with a message open the list — and therefore the search input —
     is unmounted, so `/` and the palette's "Search mail…" would silently do
     nothing. Going back to the list is asynchronous (clearSelection may pop a
     history entry), so the request is parked and the header claims it the
     moment it registers. */
  const focusPending = React.useRef(false);

  const takeFocus = (node: HTMLInputElement) => {
    node.focus();
    node.select();
  };

  const registerSearchInput = React.useCallback(
    (node: HTMLInputElement | null) => {
      searchInputRef.current = node;
      if (node && focusPending.current) {
        focusPending.current = false;
        takeFocus(node);
      }
    },
    [],
  );

  const clearSelectionRef = React.useRef(clearSelection);
  React.useEffect(() => {
    clearSelectionRef.current = clearSelection;
  }, [clearSelection]);

  const focusSearch = React.useCallback(() => {
    const input = searchInputRef.current;
    if (input) {
      takeFocus(input);
      return;
    }
    focusPending.current = true;
    clearSelectionRef.current();
  }, []);

  const value = React.useMemo<AppStateValue>(
    () => ({
      account,
      setAccount,
      folder,
      setFolder,
      unreadOnly,
      setUnreadOnly,
      setRawQuery,
      clearSearch,
      query,
      searching: query.trim().length > 0,
      view,
      setView,
      selected,
      select,
      clearSelection,
      selectedDraft,
      selectDraft,
      density: settings.density,
      toggleDensity,
      railCollapsed: settings.railCollapsed,
      setRailCollapsed,
      toggleRail,
      railSheetOpen,
      setRailSheetOpen,
      narrow,
      medium,
      railOverlay,
      setRailOverlay,
      reducedMotion,
      dialog,
      openDialog,
      closeDialog,
      palettePage,
      openPalette,
      removalTarget,
      requestRemoveAccount,
      clearRemovalTarget,
      settingsFocus,
      settingsAutoTest,
      openSettings,
      wizardOpen,
      openWizard,
      finishWizard,
      composeSeed,
      openCompose,
      replyRequest,
      requestReply,
      clearReplyRequest,
      registerSearchInput,
      focusSearch,
    }),
    [
      account,
      setAccount,
      view,
      setView,
      folder,
      unreadOnly,
      setUnreadOnly,
      clearSearch,
      query,
      selected,
      select,
      clearSelection,
      selectedDraft,
      selectDraft,
      settings.density,
      toggleDensity,
      settings.railCollapsed,
      setRailCollapsed,
      toggleRail,
      railSheetOpen,
      narrow,
      medium,
      railOverlay,
      reducedMotion,
      dialog,
      openDialog,
      closeDialog,
      palettePage,
      openPalette,
      removalTarget,
      requestRemoveAccount,
      clearRemovalTarget,
      settingsFocus,
      settingsAutoTest,
      openSettings,
      wizardOpen,
      openWizard,
      finishWizard,
      composeSeed,
      openCompose,
      replyRequest,
      requestReply,
      clearReplyRequest,
      registerSearchInput,
      focusSearch,
    ],
  );

  return (
    <AppStateContext.Provider value={value}>
      <SearchQueryContext.Provider value={rawQuery}>
        {children}
      </SearchQueryContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useApp(): AppStateValue {
  const value = React.useContext(AppStateContext);
  if (!value) throw new Error("useApp must be used inside <AppStateProvider>");
  return value;
}

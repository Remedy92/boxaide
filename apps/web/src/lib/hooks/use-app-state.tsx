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
  /**
   * Forward only: the source message's HTML part, sanitised, wrapped in the
   * same forwarded-message header the text version carries. The composer
   * cannot edit it, so it is always droppable in one click and the composer
   * says out loud that it is there (§6.4).
   */
  html?: string;
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
  /**
   * Set when the composer was opened to EDIT a queued outreach row. No REST
   * route rewrites an outbox row, so "edit" means the human takes the text and
   * sends it themselves; on a successful send the composer rejects the queued
   * copy, so the same mail cannot also go out through the engine.
   */
  outboxId?: string;
};

export type DialogName =
  | "connect"
  | "compose"
  | "shortcuts"
  | "palette"
  | "capabilities"
  | "chats"
  | "agent";

export type SettingsFocus = "baseUrl" | "token" | null;

/**
 * Settings is a page, not a dialog — one section per row of its own sidebar.
 *
 * The order is the order of the sidebar. `connection` comes first among the
 * technical ones because it is the only section that can leave the app with no
 * mail in it.
 */
export const SETTINGS_SECTIONS = [
  "general",
  "connection",
  "agents",
  "connectors",
  "appearance",
  "updates",
  "about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Which view owns the workspace.
 *
 * `agent` is the default and is a different SHAPE from the other two, not a
 * different filter: it has no message list, so the shell drops to two columns.
 * Drafts are a separate collection, not a folder.
 *
 * `people` has the same two-pane shape as mail — a list and a detail pane — but
 * over CRM rows rather than messages. `pipeline` is a board and has no list
 * column at all, so it drops to two tracks like the agent view, and so does
 * `automations`, which is one column of schedules and their run history.
 *
 * `outreach` is two-pane again: the middle column is the approval queue (or the
 * campaigns and suppression lists), and the pane is the full text of the queued
 * email a person is about to approve.
 *
 * `calendar` is one column for the same reason `automations` is: an agenda is a
 * single ordered list, and a second track would be empty until a day was
 * picked.
 */
export type View =
  | "agent"
  | "mail"
  | "drafts"
  | "calendar"
  | "people"
  | "pipeline"
  | "automations"
  | "outreach"
  | "settings";

/**
 * The views the CRM owns. With `settings.crm` off they are not reachable: the
 * rail omits them, the palette omits them, and setView refuses them — so a
 * stale caller cannot land the shell on a pane the rail has no row for.
 *
 * Automations is NOT here. It runs rules over mail, and a mail-only install is
 * exactly where a triage rule earns its keep.
 */
export const CRM_VIEWS = ["people", "pipeline", "outreach"] as const;

export function isCrmView(view: View): boolean {
  return (CRM_VIEWS as readonly View[]).includes(view);
}

/**
 * Which list the Outreach middle column is showing. All three are the same
 * view — they share a pane and a keyboard map — so this is a filter, not a
 * route.
 */
export type OutreachTab = "queue" | "campaigns" | "suppression";

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
  /** A CRM view while the CRM is off is a no-op, not a crash — see CRM_VIEWS. */
  setView: (value: View) => void;

  /* workspace. Not a filter: off means People, Pipeline and Outreach do not
     exist in this browser. Stored, so it survives a reload. */
  crm: boolean;
  setCrm: (value: boolean) => void;

  /* People. The filters live here, not in the pane, for the same reason the
     mail filters do: the list header owns the controls and the shell owns the
     keyboard map that walks the rows they produce. */
  setPeopleRawQuery: (value: string) => void;
  /** Debounced by 300ms; this is what the request uses. */
  peopleQuery: string;
  peopleTag: string | null;
  setPeopleTag: (value: string | null) => void;
  /**
   * The open contact, as a CRM row id. Plain state rather than a URL hash: the
   * hash names a message or a draft on a mail server, and a contact id is a
   * row in this machine's SQLite file with no equivalent outside it. Sharing
   * the one hash slot would also let a contact and a message both be "open".
   */
  selectedContact: string | null;
  selectContact: (value: string | null) => void;

  /* Outreach. Same reasoning as People: the list column owns the tabs and the
     shell owns the keyboard map that walks the queue they produce. The open
     row is a local outbox id, which has no meaning outside this machine, so it
     stays out of the URL hash. */
  outreachTab: OutreachTab;
  setOutreachTab: (value: OutreachTab) => void;
  selectedOutbox: string | null;
  selectOutbox: (value: string | null) => void;

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
  /** Non-null ⇒ the Connection section runs its test as it mounts. */
  settingsAutoTest: number | null;
  /** Which settings page is open. Null whenever `view` is not "settings". */
  settingsSection: SettingsSection | null;
  /** Opens the Settings page. A focus target implies the Connection section. */
  openSettings: (focus?: SettingsFocus, autoTest?: boolean) => void;
  openSettingsSection: (section: SettingsSection) => void;
  /** Leaves Settings for the view the user was in before it. */
  closeSettings: () => void;

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

/** The People search box, split off for the same reason. Only its header reads it. */
const PeopleQueryContext = React.createContext<string>("");

export function usePeopleSearchQuery(): string {
  return React.useContext(PeopleQueryContext);
}

/**
 * The Settings page, as a route.
 *
 * It is in the hash rather than in state because it has to be reachable from
 * outside the page: the desktop app's "Check for updates…" points the window
 * at `#/settings/updates`, and it has no other channel to do it with — there
 * is no preload script and no IPC. Deep-linking a section also means the
 * command palette's "Set access token" is one address, not one more flag.
 */
const SETTINGS_HASH_PATTERN = /^#\/settings(?:\/([a-z-]+))?$/;

const HASH_PATTERN = /^#\/a\/([^/]+)\/m\/(.+)$/;
/** Same shape, `d` instead of `m`. One hash, so a draft and a message can
    never both be open — which is also true of the reading pane. */
const DRAFT_HASH_PATTERN = /^#\/a\/([^/]+)\/d\/(.+)$/;

/**
 * history.replaceState fires neither `hashchange` nor `popstate`, so the store
 * below would never see a programmatic selection. This event closes that gap.
 */
const HASH_EVENT = "boxaide:hash";

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

/** Null for every hash that is not a settings route, including no hash. */
function settingsFromHash(hash: string): SettingsSection | null {
  const match = SETTINGS_HASH_PATTERN.exec(hash);
  if (!match) return null;
  const section = match[1] as SettingsSection | undefined;
  if (!section) return "general";
  // An unknown section is a typed or stale address, not a crash: the page
  // opens on its first row.
  return SETTINGS_SECTIONS.includes(section) ? section : "general";
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
  /* Agent first. The app opens on the conversation, not on a list of mail —
     that is the product's whole claim, and a default that says otherwise is the
     one place a person will believe over any amount of copy. */
  const [view, setViewState] = React.useState<View>("agent");
  const [folder, setFolder] = React.useState<string | undefined>(undefined);
  const [unreadOnly, setUnreadOnlyState] = React.useState(false);
  const [rawQuery, setRawQuery] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [peopleRawQuery, setPeopleRawQuery] = React.useState("");
  const [peopleQuery, setPeopleQuery] = React.useState("");
  const [peopleTag, setPeopleTag] = React.useState<string | null>(null);
  const [selectedContact, setSelectedContact] = React.useState<string | null>(
    null,
  );
  const [outreachTab, setOutreachTabState] =
    React.useState<OutreachTab>("queue");
  const [selectedOutbox, setSelectedOutbox] = React.useState<string | null>(
    null,
  );
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
  /* Derived, not mirrored into state: the hash IS which settings page is open,
     so the browser's Back button, the palette and the desktop menu all move
     the same one thing and no effect has to keep two copies in step. */
  const settingsSection = React.useMemo(() => settingsFromHash(hash), [hash]);

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

  /* Same 300ms, same reason. Separate timer because the two boxes are separate
     controls: typing in one must not re-issue the other's request. */
  React.useEffect(() => {
    const timer = setTimeout(() => setPeopleQuery(peopleRawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [peopleRawQuery]);

  const selectContact = React.useCallback(
    (value: string | null) => setSelectedContact(value),
    [],
  );

  const selectOutbox = React.useCallback(
    (value: string | null) => setSelectedOutbox(value),
    [],
  );

  /* The pane belongs to the queue. Leaving a row open while the column shows
     campaigns would put an approve button beside a list it is not about. */
  const setOutreachTab = React.useCallback((value: OutreachTab) => {
    setOutreachTabState(value);
    if (value !== "queue") setSelectedOutbox(null);
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
    // the user was on before Boxaide.
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

  /* Read through a ref for the same reason shownViewRef below does: setView
     must stay stable, and it is the one caller. */
  const crmRef = React.useRef(settings.crm);
  React.useEffect(() => {
    crmRef.current = settings.crm;
  }, [settings.crm]);

  /** Assigned once openSettingsSection exists, below. setView is its caller. */
  const openSettingsRef = React.useRef<(section: SettingsSection) => void>(
    () => {},
  );

  /* The pane the shell is actually rendering, which is not always `view`: a
     settings route and an open message each outrank it, and both can be set
     while `view` still holds whatever the user was on before. setView compares
     against this rather than the raw state, because the row a person presses
     is a navigation away from what they can SEE. Comparing against `view`
     swallowed two of those: leaving Settings for the view behind it, and
     leaving a message the menu-bar popover opened in a window that never left
     the agent conversation. A ref rather than a dependency, so setView stays
     stable for the many components that hold it. */
  const shownViewRef = React.useRef(view);
  React.useEffect(() => {
    shownViewRef.current = settingsSection
      ? "settings"
      : selected
        ? "mail"
        : view;
  }, [settingsSection, selected, view]);

  const setView = React.useCallback((next: View) => {
    // Settings is a route, not a view state — see openSettings.
    if (next === "settings") {
      openSettingsRef.current("general");
      return;
    }
    // The last gate before the shell renders a pane. Every surface that offers
    // a CRM row already hides it, so reaching here means a stale caller — a
    // held keybinding, another tab's palette — and the answer is to do nothing
    // rather than to show a view the rail cannot get back to.
    if (!crmRef.current && isCrmView(next)) return;
    // Nothing to do only when the pane on screen is already the one asked for.
    if (shownViewRef.current === next) return;
    /* Ahead of the effect on purpose: a second call in the same tick, which a
       held key produces, has to see the move that is already committed. */
    shownViewRef.current = next;
    clearSelectionRefForView.current();
    // The contact pane is the People view's right column and nothing else's.
    // Leaving it set would restore a stale contact on the way back in.
    setSelectedContact(null);
    // Same for the queued email in the Outreach pane — and that one carries an
    // Approve button, so a stale row there is worth more than a stale name.
    setSelectedOutbox(null);
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

  const setCrm = React.useCallback(
    (value: boolean) => updateSettings({ crm: value }),
    [updateSettings],
  );

  /* Turning the CRM off while standing in one of its views — from Settings, or
     from another tab through the storage event — would leave the shell on a
     pane with no row in the rail and no way back to it. Mail, because that is
     what the person just said they wanted. */
  const setViewRef = React.useRef(setView);
  React.useEffect(() => {
    setViewRef.current = setView;
  }, [setView]);
  React.useEffect(() => {
    if (settings.crm || !isCrmView(view)) return;
    setViewRef.current("mail");
  }, [settings.crm, view]);

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
    // A pending "focus the token field" belongs to the press that asked for
    // it. Anything else opening first has taken that press's place.
    setSettingsFocus(null);
    setSettingsAutoTest(null);
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

  /**
   * The selection Settings was opened over, so closing it can put the message
   * back. Settings and the reading pane share the one hash slot, and taking a
   * message off screen is not what opening a settings page means.
   */
  const hashBeforeSettings = React.useRef<string>("");

  /**
   * Write the settings route. `replaceState`, like a selection at desktop
   * width: Settings is a place the user goes on purpose and leaves with a
   * click, not a step in a trail they arrow back through.
   */
  const goToSettings = React.useCallback((section: SettingsSection) => {
    if (typeof window === "undefined") return;
    const current = window.location.hash;
    // Only on the way in. Moving between sections must not record a settings
    // route as the thing to go back to.
    if (!SETTINGS_HASH_PATTERN.test(current)) {
      hashBeforeSettings.current = current;
    }
    const next = `#/settings/${section}`;
    window.history.replaceState(null, "", next);
    window.dispatchEvent(new Event(HASH_EVENT));
  }, []);

  const openSettingsSection = React.useCallback(
    (section: SettingsSection) => {
      setSettingsFocus(null);
      setSettingsAutoTest(null);
      // An overlay over the page the user just asked for is nobody's intent —
      // this is reached from the palette, which is one of them.
      setDialog(null);
      goToSettings(section);
    },
    [goToSettings],
  );

  React.useEffect(() => {
    openSettingsRef.current = openSettingsSection;
  }, [openSettingsSection]);

  const openSettings = React.useCallback(
    (focus: SettingsFocus = null, autoTest = false) => {
      setSettingsFocus(focus);
      // A nonce rather than a boolean: asking twice in a row must run the test
      // twice, and a boolean that is already true would not change.
      setSettingsAutoTest(autoTest ? Date.now() : null);
      setDialog(null);
      // A focus target and the connection test are both about the server, so
      // they name the section rather than needing one passed alongside.
      goToSettings(focus || autoTest ? "connection" : "general");
    },
    [goToSettings],
  );

  const closeSettings = React.useCallback(() => {
    setSettingsFocus(null);
    setSettingsAutoTest(null);
    if (typeof window === "undefined") return;
    // Back to the message that was open, if there was one. A bare path
    // otherwise — and never a stale settings route, which would reopen the
    // page this is closing.
    const previous = hashBeforeSettings.current;
    hashBeforeSettings.current = "";
    const base = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(
      null,
      "",
      previous && !SETTINGS_HASH_PATTERN.test(previous)
        ? `${base}${previous}`
        : base,
    );
    window.dispatchEvent(new Event(HASH_EVENT));
  }, []);

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
      outboxId: seed?.outboxId,
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
      /* The settings route wins while it is set. The view underneath is kept,
         not cleared, so leaving Settings returns to the pane the user left.
         An open message wins for the same reason and in the same way: the
         menu-bar popover raises the window on the row that was clicked, and
         the app starts on the agent conversation, which has no reading pane
         to show it in. Closing the message returns to the view underneath. */
      view: settingsSection ? "settings" : selected ? "mail" : view,
      setView,
      /* Gated on mount for the same reason the wizard is: the hydration render
         reads DEFAULT_SETTINGS, where `crm` is true, so passing settings.crm
         straight through would paint People, Pipeline and Outreach for one
         frame in a browser that turned them off. Held false until this
         browser's own value is readable — the section then appears once,
         rather than appearing and being taken away. */
      crm: mounted && settings.crm,
      setCrm,
      setPeopleRawQuery,
      peopleQuery,
      peopleTag,
      setPeopleTag,
      selectedContact,
      selectContact,
      outreachTab,
      setOutreachTab,
      selectedOutbox,
      selectOutbox,
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
      settingsSection,
      openSettings,
      openSettingsSection,
      closeSettings,
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
      mounted,
      settings.crm,
      setCrm,
      folder,
      unreadOnly,
      setUnreadOnly,
      clearSearch,
      query,
      peopleQuery,
      peopleTag,
      selectedContact,
      selectContact,
      outreachTab,
      setOutreachTab,
      selectedOutbox,
      selectOutbox,
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
      settingsSection,
      openSettings,
      openSettingsSection,
      closeSettings,
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
        <PeopleQueryContext.Provider value={peopleRawQuery}>
          {children}
        </PeopleQueryContext.Provider>
      </SearchQueryContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useApp(): AppStateValue {
  const value = React.useContext(AppStateContext);
  if (!value) throw new Error("useApp must be used inside <AppStateProvider>");
  return value;
}

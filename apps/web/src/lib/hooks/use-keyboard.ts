"use client";

import * as React from "react";

/**
 * The global keyboard map (§9).
 *
 * Every single-letter binding is suppressed when the event target is an input,
 * a textarea or a contenteditable, when any overlay is open, and when a
 * modifier other than the one listed is held.
 *
 * Explicitly unbound and staying that way: e, s, h, #, !, z, x, l, v. Each maps
 * to a Gmail or Superhuman action this backend cannot perform, and a shortcut
 * that toasts "not supported" is worse than a key that does nothing.
 */

export type KeyboardHandlers = {
  next: () => void;
  previous: () => void;
  open: () => void;
  escape: () => void;
  toggleRead: () => void;
  reply: () => void;
  replyAll: () => void;
  forward: () => void;
  compose: () => void;
  focusSearch: () => void;
  commandPalette: () => void;
  shortcuts: () => void;
  goAgent: () => void;
  goInbox: () => void;
  goUnread: () => void;
  goDrafts: () => void;
  goAccount: (index: number) => void;
  goFolder: () => void;
  toggleRail: () => void;
  scrollReader: (direction: 1 | -1) => void;
};

const G_WINDOW_MS = 1300;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function useKeyboard(
  handlers: KeyboardHandlers,
  options: { suspended: boolean },
) {
  // The handler map is rebuilt every render; the listener must always call the
  // latest one without re-subscribing. Writing the ref in an effect keeps the
  // render pass free of ref access.
  const ref = React.useRef(handlers);
  React.useEffect(() => {
    ref.current = handlers;
  });
  const suspended = options.suspended;
  const [gPending, setGPending] = React.useState(false);
  const gTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrored into a ref so pressing `g` does not tear down and re-add the
  // window listener on every chord.
  const gPendingRef = React.useRef(false);

  const closeGWindow = React.useCallback(() => {
    if (gTimer.current) clearTimeout(gTimer.current);
    gTimer.current = null;
    gPendingRef.current = false;
    setGPending(false);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const h = ref.current;
      const typing = isTypingTarget(event.target);
      const mod = event.metaKey || event.ctrlKey;

      // ⌘K / Ctrl+K works from anywhere, including a focused input.
      if (mod && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        h.commandPalette();
        return;
      }

      if (event.key === "Escape") {
        // Radix owns Escape while a dialog is open; suspended covers that.
        if (!suspended) {
          closeGWindow();
          h.escape();
        }
        return;
      }

      if (suspended || typing || mod || event.altKey) return;

      if (gPendingRef.current) {
        const key = event.key;
        closeGWindow();
        if (key === "a") {
          event.preventDefault();
          h.goAgent();
        } else if (key === "i") {
          event.preventDefault();
          h.goInbox();
        } else if (key === "u") {
          event.preventDefault();
          h.goUnread();
        } else if (key === "d") {
          event.preventDefault();
          h.goDrafts();
        } else if (key === "f") {
          event.preventDefault();
          h.goFolder();
        } else if (/^[1-9]$/.test(key)) {
          event.preventDefault();
          h.goAccount(Number(key) - 1);
        }
        // Any other key cancels silently: no toast, no error.
        return;
      }

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          h.next();
          return;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          h.previous();
          return;
        case "Enter":
        case "o":
          event.preventDefault();
          h.open();
          return;
        case "u":
          event.preventDefault();
          h.toggleRead();
          return;
        case "r":
          event.preventDefault();
          h.reply();
          return;
        case "a":
          event.preventDefault();
          h.replyAll();
          return;
        case "f":
          event.preventDefault();
          h.forward();
          return;
        case "c":
          event.preventDefault();
          h.compose();
          return;
        case "/":
          event.preventDefault();
          h.focusSearch();
          return;
        case "?":
          event.preventDefault();
          h.shortcuts();
          return;
        case "[":
          event.preventDefault();
          h.toggleRail();
          return;
        case "g":
          event.preventDefault();
          gPendingRef.current = true;
          setGPending(true);
          if (gTimer.current) clearTimeout(gTimer.current);
          gTimer.current = setTimeout(() => {
            gPendingRef.current = false;
            setGPending(false);
          }, G_WINDOW_MS);
          return;
        case " ":
          event.preventDefault();
          h.scrollReader(event.shiftKey ? -1 : 1);
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeGWindow, suspended]);

  React.useEffect(() => {
    return () => {
      if (gTimer.current) clearTimeout(gTimer.current);
    };
  }, []);

  /** True while the `g…` window is open, so the rail footer can show it. */
  return { gPending };
}

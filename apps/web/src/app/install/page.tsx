"use client";

import * as React from "react";
import { ArrowDownToLine, Check, Copy } from "lucide-react";
import { BrandGlyph } from "@/components/atoms";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn, copyToClipboard } from "@/lib/utils";
import { AppMark } from "./app-mark";
import { HeroBeams } from "./hero-beams";
import "./install.css";

/**
 * The page a stranger lands on. One viewport, one button.
 *
 * Written for someone who has never opened a terminal and never will: the
 * primary control downloads the desktop app for the operating system they are
 * reading this on, and the only thing under it is what to do with the file. The
 * clone-and-run path still exists — it is one line of 12px text at the bottom,
 * where the people who want it will look and nobody else has to.
 *
 * It borrows the product's tokens (surfaces, ink, the single indigo, the
 * 100–150ms motion) and adds one thing the app does not have: display type.
 * A 52px headline has no place in a mail client, so it is not a token; it lives
 * here, on the one page that needs it.
 */

const REPO_URL = "https://github.com/Remedy92/boxaide";

/**
 * GitHub keeps this path pointing at the newest release for ever, so the button
 * never carries a version number and never goes stale. The file names are
 * pinned in apps/desktop/electron-builder.yml — change one and change the other.
 *
 * It resolves only once a release exists. Until `gh release create` has run
 * once, every button on this page reaches a GitHub 404.
 */
const RELEASE_BASE = `${REPO_URL}/releases/latest/download`;

/**
 * `phone` is not a platform we build for — it is the visitor who cannot install
 * anything from where they are standing, and the page owes them a straight
 * answer rather than a .dmg their phone will never open.
 */
type Platform = "mac" | "windows" | "linux";
type Visitor = Platform | "phone";

/**
 * `file: null` means that platform has no published installer yet. The links
 * fall back to the release page, which lists whatever the newest release does
 * hold, and the button stops promising a download it cannot deliver. Filling
 * one in is the whole change needed when its installer ships — the names are
 * pinned in apps/desktop/electron-builder.yml.
 */
const DOWNLOADS: Record<
  Platform,
  { name: string; file: string | null; needs: string; next: string }
> = {
  mac: {
    name: "Mac",
    file: "boxaide-mac.dmg",
    // Apple silicon only. `electron-builder --mac dmg` builds for the host
    // architecture, and this was built on an M-series machine; `lipo -archs`
    // on the packaged binary reports arm64 alone. Saying "macOS 12 or later"
    // on its own would hand an Intel Mac a file it cannot run.
    needs: "macOS 12 or later, Apple silicon",
    next: "Drag Boxaide into Applications, then open it.",
  },
  windows: {
    name: "Windows",
    file: null,
    needs: "Windows 10 or later",
    next: "Open the file in your Downloads and follow the installer.",
  },
  linux: {
    name: "Linux",
    file: null,
    needs: "AppImage, any recent distribution",
    next: "Mark the file as executable, then open it.",
  },
};

const RELEASES_URL = `${REPO_URL}/releases/latest`;

function downloadHref(id: Platform): string {
  const file = DOWNLOADS[id].file;
  return file ? `${RELEASE_BASE}/${file}` : RELEASES_URL;
}

const ORDER: readonly Platform[] = ["mac", "windows", "linux"];

const COMMAND_LINES = [
  "git clone https://github.com/Remedy92/boxaide.git",
  "cd boxaide && npm install && npm run dev",
] as const;

const COMMAND = COMMAND_LINES.join("\n");

/** How long the copy icon stays a check before the affordance returns. */
const CHECK_MS = 1_600;

/**
 * The visitor's platform as an external store rather than a setState in an
 * effect — the same shape ThemeToggle uses. The server snapshot is null, the
 * client snapshot is a string constant, and React swaps them after hydration
 * without a second render pass.
 */
const NO_OP_SUBSCRIBE = () => () => {};
const SERVER_PLATFORM = () => null;

function detectPlatform(): Visitor {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android/.test(ua)) return "phone";
  if (/Mac/.test(ua)) return "mac";
  if (/Win/.test(ua)) return "windows";
  return "linux";
}

export default function InstallPage() {
  // null until hydration: a static export is prerendered on a build machine,
  // and a page that guesses "Mac" and corrects itself is worse than one word of
  // delay behind the button's own entrance.
  const platform = React.useSyncExternalStore(
    NO_OP_SUBSCRIBE,
    detectPlatform,
    SERVER_PLATFORM,
  );
  const [started, setStarted] = React.useState(false);
  const [source, setSource] = React.useState(false);
  const [checked, setChecked] = React.useState(false);
  const [manual, setManual] = React.useState(false);
  const commandRef = React.useRef<HTMLSpanElement>(null);
  const checkTimer = React.useRef<number | undefined>(undefined);

  React.useEffect(() => () => window.clearTimeout(checkTimer.current), []);

  const current = platform && platform !== "phone" ? DOWNLOADS[platform] : null;
  const others = ORDER.filter((id) => id !== platform);

  async function handleCopy() {
    if (await copyToClipboard(COMMAND)) {
      setManual(false);
      setChecked(true);
      window.clearTimeout(checkTimer.current);
      checkTimer.current = window.setTimeout(() => setChecked(false), CHECK_MS);
      return;
    }
    // No clipboard — an insecure context, or a browser that refused. Select the
    // text so the keyboard still works.
    const node = commandRef.current;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setManual(true);
  }

  return (
    <main className="pane-scroll relative h-[100dvh] overflow-y-auto bg-surface-1">
      {/* Behind everything, and inert: two soft lights, film grain, and the
          mark's own geometry at page scale. */}
      <div className="mailmux-atmosphere">
        <div className="absolute inset-0 text-fg opacity-[0.10] dark:opacity-[0.16]">
          <HeroBeams />
        </div>
      </div>

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-[680px] flex-col px-6">
        <header className="flex h-14 shrink-0 items-center justify-between">
          <span className="flex items-center gap-2 text-fg">
            <BrandGlyph size={13} />
            <span className="text-[13px] font-medium tracking-[-0.006em]">
              Boxaide
            </span>
          </span>
          <ThemeToggle />
        </header>

        {/* The hero owns the leftover height and centres inside it, so the page
            holds still from a 640px laptop to a 1600px display. */}
        <section className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <span className="mailmux-rise mailmux-mark-shadow">
            <AppMark size={92} />
          </span>

          <span
            className="mailmux-rise mt-8 inline-flex items-center rounded-[var(--radius-full)] border border-border-subtle bg-surface-2/60 px-3 py-1 text-[12px] leading-[18px] text-fg-secondary backdrop-blur-[2px]"
            style={{ animationDelay: "40ms" }}
          >
            Works with Claude, Cursor and any MCP agent
          </span>

          <h1
            className="mailmux-display mailmux-rise mt-5 text-[clamp(32px,6.2vw,58px)] font-semibold leading-[1.04] tracking-[-0.032em] text-fg"
            style={{ animationDelay: "80ms" }}
          >
            Every mailbox.
            <br />
            One inbox.
          </h1>

          <p
            className="mailmux-rise mt-5 max-w-[40ch] text-[15px] leading-[24px] text-fg-secondary"
            style={{ animationDelay: "120ms" }}
          >
            Gmail, Outlook, iCloud and work mail in one window. Everything stays
            on your computer.
          </p>

          <a
            href={
              platform === "phone"
                ? REPO_URL
                : platform
                  ? downloadHref(platform)
                  : RELEASES_URL
            }
            onClick={() => setStarted(true)}
            style={{ animationDelay: "170ms" }}
            className={cn(
              "mailmux-cta mailmux-rise mt-9 inline-flex h-11 items-center gap-2",
              "rounded-[var(--radius-lg)] bg-accent-fill px-7",
              "text-[15px] font-medium text-accent-fill-fg",
              "hover:bg-[var(--accent-fill-hover)]",
            )}
          >
            <ArrowDownToLine strokeWidth={1.75} className="size-[17px]" />
            {current?.file
              ? `Download for ${current.name}`
              : platform === "phone"
                ? "See it on GitHub"
                : current
                  ? "Get Boxaide"
                  : "Download Boxaide"}
          </a>

          {/* One line, two states: what it needs, then what to do with the file
              it just gave you. A fixed height so the swap moves nothing. */}
          <div
            aria-live="polite"
            className="mt-4 flex min-h-11 items-center justify-center"
          >
            <p
              key={started ? "next" : "needs"}
              className="mailmux-rise max-w-[46ch] text-[12px] leading-[16px] text-fg-tertiary"
              style={{ animationDelay: started ? "0ms" : "190ms" }}
            >
              {started && current?.file
                ? current.next
                : platform === "phone"
                  ? "Boxaide runs on your computer. Open this page there to install it."
                  : current && !current.file
                    ? `There is no ${current.name} installer yet. Run it from source below — it takes two commands.`
                    : `Free and open source · ${current?.needs ?? "macOS, Windows and Linux"}`}
            </p>
          </div>

          {/* Everyone else: the other two platforms, and the terminal. */}
          <p
            className="mailmux-rise mt-2 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[12px] text-fg-tertiary"
            style={{ animationDelay: "240ms" }}
          >
            {others.map((id) => (
              <React.Fragment key={id}>
                <a
                  href={downloadHref(id)}
                  className="transition-colors duration-[var(--dur-fast)] hover:text-fg-secondary"
                >
                  {DOWNLOADS[id].name}
                </a>
                <span aria-hidden="true">·</span>
              </React.Fragment>
            ))}
            <button
              type="button"
              onClick={() => setSource((open) => !open)}
              aria-expanded={source}
              className="rounded-[var(--radius-xs)] transition-colors duration-[var(--dur-fast)] hover:text-fg-secondary"
            >
              Run it from source
            </button>
          </p>

          {source ? (
            <div className="mailmux-expand mt-5 flex flex-col items-center">
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy the install command"
                className={cn(
                  "group flex w-fit max-w-full items-center gap-4",
                  "rounded-[var(--radius-lg)] border border-border-subtle bg-surface-0",
                  "py-3 pl-3.5 pr-3 text-left",
                  "transition-[border-color,background-color] duration-[var(--dur-fast)]",
                  "hover:border-border-strong hover:bg-surface-hover",
                  "active:translate-y-[0.5px]",
                )}
              >
                <span
                  ref={commandRef}
                  className="min-w-0 font-mono text-[clamp(10.5px,2.7vw,12px)] leading-[20px] text-fg [overflow-wrap:anywhere]"
                >
                  {COMMAND_LINES.map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </span>

                {/* One 16px slot, two icons crossfading in place — no layout
                    shift and no second control to look at. */}
                <span
                  aria-hidden="true"
                  className="pointer-events-none grid size-4 shrink-0 place-items-center"
                >
                  <Copy
                    strokeWidth={1.5}
                    className={cn(
                      "col-start-1 row-start-1 size-4 text-fg-tertiary transition-opacity duration-[var(--dur-fast)]",
                      "group-hover:text-fg-secondary",
                      checked ? "opacity-0" : "opacity-100",
                    )}
                  />
                  <Check
                    strokeWidth={1.5}
                    className={cn(
                      "col-start-1 row-start-1 size-4 text-accent transition-opacity duration-[var(--dur-fast)]",
                      checked ? "opacity-100" : "opacity-0",
                    )}
                  />
                </span>
              </button>
              <p className="mt-3 text-[12px] leading-[16px] text-fg-tertiary">
                {manual
                  ? "Your browser blocked the copy — the command is selected, press ⌘C."
                  : "Needs git and Node 22 or newer."}
              </p>
            </div>
          ) : null}
        </section>

        <footer className="flex h-14 shrink-0 items-center justify-center gap-2.5 text-[12px] text-fg-tertiary">
          <span>Free, MIT licensed</span>
          <span aria-hidden="true">·</span>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-[var(--radius-xs)] transition-colors duration-[var(--dur-fast)] hover:text-fg-secondary"
          >
            Source on GitHub
          </a>
        </footer>
      </div>
    </main>
  );
}

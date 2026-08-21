"use client";

import * as React from "react";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Inbox,
  Laptop,
  Lock,
  Send,
  Sparkles,
  Users,
} from "lucide-react";
import { BrandGlyph } from "@/components/atoms";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn, copyToClipboard } from "@/lib/utils";
import { AppMark } from "./app-mark";
import {
  ClaudeMark,
  CodexMark,
  CursorMark,
  GmailMark,
  GrokMark,
  ICloudMark,
  OpenCodeMark,
  OutlookMark,
} from "./brand-marks";
import { HeroBeams } from "./hero-beams";
import { useRevealOnScroll, useScrollAtmosphere } from "./use-scroll-motion";
import "./install.css";

/**
 * The page a stranger lands on.
 *
 * The first screen is still one viewport and one button: the primary control
 * downloads the desktop app for the operating system they are reading this on,
 * and the clone-and-run path is one line of 12px text where the people who want
 * it will look. What follows it answers the question the button raises. Boxaide
 * is no longer only a mail client, and a hero that says "one inbox" and stops
 * undersells the CRM, the automations and the outreach queue by leaving them
 * out. Each section below is one claim and one sentence.
 *
 * It borrows the product's tokens (surfaces, ink, the single indigo) and adds
 * two things the app does not have: display type, and motion measured in
 * hundreds of milliseconds rather than a hundred. A 58px headline and a 620ms
 * reveal have no place in a mail client you keep open all day. They belong
 * here, on the one page that is looked at once.
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
 * What the page names it connects to. Presets live in lib/constants.ts and the
 * launchable agents in src/agent/launcher.ts; these are the ones with a mark to
 * draw, and the line under each row carries the rest.
 */
const MAILBOXES = [
  { name: "Gmail", Mark: GmailMark },
  { name: "Outlook", Mark: OutlookMark },
  { name: "iCloud", Mark: ICloudMark },
] as const;

const AGENTS = [
  { name: "Claude", Mark: ClaudeMark },
  { name: "Cursor", Mark: CursorMark },
  { name: "Codex", Mark: CodexMark },
  { name: "Grok", Mark: GrokMark },
  { name: "OpenCode", Mark: OpenCodeMark },
] as const;

const FEATURES = [
  {
    Icon: Inbox,
    title: "One inbox",
    body: "Every account in one list. Read, reply, search and archive without switching windows.",
  },
  {
    Icon: Users,
    title: "A CRM you never typed",
    body: "Contacts, companies, a timeline and a deal pipeline, built from the mail you already have.",
  },
  {
    Icon: Clock,
    title: "Automations on a schedule",
    body: "A prompt on a cron. It reads yesterday's mail, updates the CRM and leaves the work done.",
  },
  {
    Icon: Send,
    title: "Outreach that waits",
    body: "Your agent writes the message and queues it. None of it moves until you say so.",
  },
] as const;

const ASSURANCES = [
  {
    Icon: Laptop,
    title: "On your machine",
    body: "No cloud account, no sync, no server of ours in the path.",
  },
  {
    Icon: Lock,
    title: "Encrypted at rest",
    body: "Passwords, drafts and anything mail-derived, under one master key.",
  },
  {
    Icon: Sparkles,
    title: "Free and MIT",
    body: "The whole thing, source included. Nothing is held back for a paid tier.",
  },
] as const;

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

  // The page does not scroll the window: the body is `overflow: hidden` for the
  // whole product, so this element is the scroller and both hooks read it.
  const scrollRef = React.useRef<HTMLElement>(null);
  useRevealOnScroll(scrollRef);
  useScrollAtmosphere(scrollRef);

  React.useEffect(() => () => window.clearTimeout(checkTimer.current), []);

  const current = platform && platform !== "phone" ? DOWNLOADS[platform] : null;
  const others = ORDER.filter((id) => id !== platform);

  const primaryHref =
    platform === "phone"
      ? REPO_URL
      : platform
        ? downloadHref(platform)
        : RELEASES_URL;

  const primaryLabel = current?.file
    ? `Download for ${current.name}`
    : platform === "phone"
      ? "See it on GitHub"
      : current
        ? "Get Boxaide"
        : "Download Boxaide";

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
    <main
      ref={scrollRef}
      data-armed=""
      className="pane-scroll relative h-[100dvh] overflow-y-auto bg-surface-1"
    >
      {/* The hidden half of every reveal lives in CSS under [data-armed], so
          the server's HTML is already hiding them and nothing flashes in and
          out while React hydrates. A browser with no script cancels the whole
          arrangement here rather than showing an empty page. */}
      <noscript>
        {/* Every armed selector is repeated, because the two that carry their
            own hidden state outrank the plain one and would otherwise hold. */}
        <style>
          {"[data-armed] [data-reveal],[data-armed] .mailmux-section-title[data-reveal],[data-armed] .mailmux-mark-seat[data-reveal]{opacity:1;transform:none;filter:none}"}
        </style>
      </noscript>

      {/* Behind everything, and inert: two soft lights, film grain, and the
          mark's own geometry at page scale, drifting a quarter as fast as the
          page moves. */}
      <div className="mailmux-atmosphere">
        <div className="absolute inset-0 text-fg opacity-[0.10] dark:opacity-[0.16]">
          <HeroBeams />
        </div>
      </div>

      <header className="mailmux-header sticky top-0 z-30">
        <div className="mx-auto flex h-14 w-full max-w-[680px] items-center justify-between px-6">
          <span className="flex items-center gap-2 text-fg">
            <BrandGlyph size={13} />
            <span className="text-[13px] font-medium tracking-[-0.006em]">
              Boxaide
            </span>
          </span>
          <ThemeToggle />
        </div>
      </header>

      <div className="relative z-10">
        {/* The hero owns a viewport minus the header and centres inside it, so
            the first screen holds still from a 640px laptop to a 1600px
            display. */}
        <section className="mx-auto flex min-h-[calc(100dvh-56px)] w-full max-w-[680px] flex-col items-center justify-center px-6 py-8 text-center">
          <span
            className="mailmux-mark-shadow mailmux-mark-seat"
            data-reveal="0"
          >
            <AppMark size={92} />
          </span>

          <span
            data-reveal="1"
            className="mt-8 inline-flex items-center gap-2 rounded-[var(--radius-full)] border border-border-subtle bg-surface-2/60 px-3 py-1 text-[12px] leading-[18px] text-fg-secondary backdrop-blur-[2px]"
          >
            <span
              aria-hidden="true"
              className="size-[5px] rounded-full bg-accent"
            />
            Works with Claude, Cursor and any MCP agent
          </span>

          <h1
            data-reveal="2"
            className="mailmux-display mt-5 text-[clamp(32px,6.2vw,58px)] font-semibold leading-[1.04] tracking-[-0.032em] text-fg"
          >
            Every mailbox.
            <br />
            One agent.
          </h1>

          <p
            data-reveal="3"
            className="mt-5 max-w-[46ch] text-[15px] leading-[24px] text-fg-secondary"
          >
            Connect as many mailboxes as you want, then point every agent on
            your machine at all of them. Nothing leaves your computer.
          </p>

          <a
            href={primaryHref}
            onClick={() => setStarted(true)}
            data-reveal="4"
            className={cn(
              "mailmux-cta mt-9 inline-flex h-11 items-center gap-2",
              "rounded-[var(--radius-lg)] bg-accent-fill px-7",
              "text-[15px] font-medium text-accent-fill-fg",
              "hover:bg-[var(--accent-fill-hover)]",
            )}
          >
            <ArrowDownToLine strokeWidth={1.75} className="size-[17px]" />
            {primaryLabel}
          </a>

          {/* One line, two states: what it needs, then what to do with the file
              it just gave you. A fixed height so the swap moves nothing. */}
          <div
            aria-live="polite"
            data-reveal="5"
            className="mt-4 flex min-h-11 items-center justify-center"
          >
            <p className="max-w-[46ch] text-[12px] leading-[16px] text-fg-tertiary">
              {started && current?.file
                ? current.next
                : platform === "phone"
                  ? "Boxaide runs on your computer. Open this page there to install it."
                  : current && !current.file
                    ? `There is no ${current.name} installer yet. Run it from source below; it takes two commands.`
                    : `Free and open source · ${current?.needs ?? "Mac installer"}`}
            </p>
          </div>

          {/* Everyone else: the other two platforms, and the terminal. */}
          <p
            data-reveal="6"
            className="mt-2 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[12px] text-fg-tertiary"
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
                  ? "Your browser blocked the copy. The command is selected, press ⌘C."
                  : "Needs git and Node 22 or newer."}
              </p>
            </div>
          ) : null}

          <ChevronDown
            aria-hidden="true"
            strokeWidth={1.5}
            className="mailmux-cue mt-10 size-5 text-fg-tertiary"
          />
        </section>

        {/* What it plugs into. The one section that is a list of names, so it
            is the one section with no prose. */}
        <section className="mailmux-rule border-y border-border-subtle bg-surface-0 py-10">
          <div className="mx-auto grid w-full max-w-[940px] grid-cols-1 gap-10 px-6 sm:grid-cols-[0.8fr_1.2fr] sm:gap-12">
            <div className="flex flex-col gap-4">
              <p
                data-reveal="0"
                className="text-[11px] uppercase leading-4 tracking-[var(--tracking-label)] text-fg-tertiary"
              >
                Your mailboxes
              </p>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
                {MAILBOXES.map(({ name, Mark }, i) => (
                  <span
                    key={name}
                    data-reveal={i + 1}
                    className="mailmux-logo inline-flex items-center gap-2 text-[13px] tracking-[-0.006em] text-fg"
                  >
                    <Mark size={20} className="shrink-0 text-fg-secondary" />
                    {name}
                  </span>
                ))}
              </div>
              <p
                data-reveal="4"
                className="max-w-[42ch] text-[12px] leading-[18px] text-fg-tertiary"
              >
                Fastmail, work mail, and anything else that speaks IMAP. Add as
                many as you like.
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <p
                data-reveal="0"
                className="text-[11px] uppercase leading-4 tracking-[var(--tracking-label)] text-fg-tertiary"
              >
                Your agents
              </p>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
                {AGENTS.map(({ name, Mark }, i) => (
                  <span
                    key={name}
                    data-reveal={i + 1}
                    className="mailmux-logo inline-flex items-center gap-2 text-[13px] tracking-[-0.006em] text-fg"
                  >
                    <Mark size={20} className="shrink-0 text-fg-secondary" />
                    {name}
                  </span>
                ))}
              </div>
              <p
                data-reveal="6"
                className="max-w-[42ch] text-[12px] leading-[18px] text-fg-tertiary"
              >
                One MCP address, shared by every client on the machine. No
                per-agent login.
              </p>
            </div>
          </div>
        </section>

        <section className="py-18 sm:py-20">
          <div className="mx-auto w-full max-w-[940px] px-6">
            <h2 data-reveal="0" className="mailmux-section-title">
              All your mailboxes connected to all your agents
            </h2>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {FEATURES.map(({ Icon, title, body }, i) => (
                <div
                  key={title}
                  data-reveal={i + 1}
                  className="mailmux-card flex flex-col gap-2.5 rounded-[var(--radius-lg)] border border-border-subtle bg-surface-2 p-[22px]"
                >
                  <span className="grid size-[34px] place-items-center rounded-[var(--radius-md)] border border-border-subtle bg-surface-0 text-accent">
                    <Icon strokeWidth={1.6} className="size-5" />
                  </span>
                  <p className="mt-1 text-[15px] font-medium tracking-[-0.011em] text-fg">
                    {title}
                  </p>
                  <p className="text-[13px] leading-5 text-fg-secondary [text-wrap:pretty]">
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* The one thing that separates this from every other agent inbox, so
            it gets a band of its own and the only illustration on the page. */}
        <section className="border-t border-border-subtle bg-surface-0 py-18 sm:py-20">
          <div className="mx-auto grid w-full max-w-[940px] grid-cols-1 items-center gap-10 px-6 sm:grid-cols-2 sm:gap-12">
            <div>
              <h2 data-reveal="0" className="mailmux-section-title">
                Nothing sends without you.
              </h2>
              <p
                data-reveal="1"
                className="mt-4 max-w-[44ch] text-[14px] leading-[22px] text-fg-secondary [text-wrap:pretty]"
              >
                An agent that reads mail from strangers does not get to send
                mail, book a meeting or cancel one. It asks. The request waits
                in the window, showing the whole message rather than a preview,
                until you answer.
              </p>
            </div>

            <div
              data-reveal="2"
              aria-hidden="true"
              className="mailmux-ask flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-accent-line bg-surface-2 p-[18px]"
            >
              <p className="mb-1.5 text-[11px] uppercase tracking-[var(--tracking-label)] text-accent">
                Your agent wants to send
              </p>
              <p className="text-[13px] leading-5 text-fg">
                To: hannah@northline.co
              </p>
              <p className="text-[13px] font-medium leading-5 text-fg">
                Re: Thursday&rsquo;s numbers
              </p>
              <p className="mt-1.5 text-[13px] leading-5 text-fg-secondary">
                Hi Hannah, the revised figures are attached. Happy to walk
                through them before the board call.
              </p>
              <div className="mt-3.5 flex gap-2">
                <span className="inline-flex h-[30px] items-center rounded-[var(--radius-md)] bg-accent-fill px-3.5 text-[13px] font-medium text-accent-fill-fg">
                  Send it
                </span>
                <span className="inline-flex h-[30px] items-center rounded-[var(--radius-md)] border border-border-strong px-3.5 text-[13px] text-fg-secondary">
                  Don&rsquo;t
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="py-18 sm:py-20">
          <div className="mx-auto grid w-full max-w-[940px] grid-cols-1 gap-7 px-6 sm:grid-cols-3">
            {ASSURANCES.map(({ Icon, title, body }, i) => (
              <div key={title} data-reveal={i} className="flex flex-col gap-2.5">
                <span className="grid size-[34px] place-items-center rounded-[var(--radius-md)] border border-border-subtle bg-surface-0 text-accent">
                  <Icon strokeWidth={1.6} className="size-5" />
                </span>
                <p className="mt-1 text-[15px] font-medium tracking-[-0.011em] text-fg">
                  {title}
                </p>
                <p className="text-[13px] leading-5 text-fg-secondary [text-wrap:pretty]">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-border-subtle px-6 pb-2 pt-[76px] text-center">
          <div className="mx-auto flex w-full max-w-[680px] flex-col items-center">
            <h2
              data-reveal="0"
              className="mailmux-display text-[clamp(26px,4.4vw,32px)] font-semibold leading-[1.16] tracking-[-0.026em] text-fg"
            >
              Point your agent at your mail.
            </h2>

            <a
              href={primaryHref}
              onClick={() => setStarted(true)}
              data-reveal="1"
              className={cn(
                "mailmux-cta mt-8 inline-flex h-11 items-center gap-2",
                "rounded-[var(--radius-lg)] bg-accent-fill px-7",
                "text-[15px] font-medium text-accent-fill-fg",
                "hover:bg-[var(--accent-fill-hover)]",
              )}
            >
              <ArrowDownToLine strokeWidth={1.75} className="size-[17px]" />
              {primaryLabel}
            </a>

            <p
              data-reveal="2"
              className="mt-4 text-[12px] leading-[16px] text-fg-tertiary"
            >
              Free and open source · {current?.needs ?? "Mac installer"}
            </p>
          </div>
        </section>

        <footer className="flex h-[72px] items-center justify-center gap-2.5 text-[12px] text-fg-tertiary">
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

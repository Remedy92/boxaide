"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { BrandGlyph } from "@/components/atoms";
import { presenceDisplayName } from "@/components/agent/agent-presence";
import {
  getAgentState,
  getLocalBootstrap,
  listAutomations,
  listMessages,
  listRecentAutomationRuns,
} from "@/lib/api/endpoints";
import { displayName } from "@/lib/format/address";
import { runStatusLabel } from "@/lib/format/automation";
import { formatListDate } from "@/lib/format/date";
import type { AutomationRunStatus } from "@/lib/types";
import { useSettings } from "@/lib/hooks/use-settings";
import { cn } from "@/lib/utils";
import { takeDesktopBootstrapCapability } from "@/lib/desktop-bootstrap";

/**
 * The menu-bar popover. Loaded by the desktop shell's tray window at `/tray/`,
 * always same-origin with the server. It normally reads the token already
 * saved by the main desktop window; a fragment capability is supported for a
 * direct shell launch without weakening bootstrap for ordinary browsers.
 *
 * It is a glance, not a client: recent mail, whether an agent is listening,
 * one button into the app. Clicking anything that needs more room navigates
 * to `/` — the desktop shell intercepts that and raises the main window.
 *
 * In a plain browser the page still works (it is part of the static export);
 * navigation then simply opens the inbox in the same tab.
 */

const REFRESH_AGENT_MS = 8_000;
const REFRESH_RUNS_MS = 30_000;
const LIST_LIMIT = 9;
/** Three rows: a glance, not a history. The view has the rest. */
const RUNS_LIMIT = 3;

const RUN_DOT: Record<AutomationRunStatus, string> = {
  running: "bg-accent",
  ok: "bg-success",
  error: "bg-danger",
  killed: "bg-warning",
};

/**
 * A full document navigation on purpose — not router.push. The desktop shell
 * raises the main window from its will-navigate hook, and client-side routing
 * never fires that. Absolute URL, so no relative-destination lint concern.
 */
function openInbox() {
  window.location.assign(new URL("/", window.location.origin).toString());
}

function useTrayCtx() {
  const settings = useSettings();
  // The popover is served by the server it reads from, so the page's own
  // origin — not the configurable settings value — is the right base URL.
  // Lazy init: window is absent during the static-export prerender.
  const [origin] = React.useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );
  const [bootstrapCapability] = React.useState(takeDesktopBootstrapCapability);

  const bootstrap = useQuery({
    queryKey: ["tray-bootstrap", origin],
    enabled:
      origin.length > 0 &&
      settings.token.length === 0 &&
      bootstrapCapability.length > 0,
    queryFn: ({ signal }) =>
      getLocalBootstrap(
        { baseUrl: origin, token: "", signal },
        bootstrapCapability,
      ),
    staleTime: Infinity,
    retry: false,
  });

  const token = settings.token || bootstrap.data?.token || "";
  return { baseUrl: origin, token, ready: origin.length > 0 && token.length > 0 };
}

export default function TrayPage() {
  const ctx = useTrayCtx();

  const mail = useQuery({
    queryKey: ["tray-messages", ctx.baseUrl, ctx.token],
    enabled: ctx.ready,
    queryFn: ({ signal }) =>
      listMessages({ account: "all", limit: LIST_LIMIT }, { ...ctx, signal }),
    staleTime: 30_000,
  });

  const agent = useQuery({
    queryKey: ["tray-agent", ctx.baseUrl, ctx.token],
    enabled: ctx.ready,
    queryFn: ({ signal }) => getAgentState({ ...ctx, signal }),
    refetchInterval: REFRESH_AGENT_MS,
  });

  /* The last few automation runs, with the automation's name. Two requests,
     because the run row carries an id and not a name, and the list is the
     one place the name lives. Same cadence as the rail's badge. */
  const runs = useQuery({
    queryKey: ["tray-runs", ctx.baseUrl, ctx.token],
    enabled: ctx.ready,
    queryFn: ({ signal }) =>
      listRecentAutomationRuns({ ...ctx, signal }, RUNS_LIMIT),
    refetchInterval: REFRESH_RUNS_MS,
    retry: false,
  });
  const automations = useQuery({
    queryKey: ["tray-automations", ctx.baseUrl, ctx.token],
    enabled: ctx.ready,
    queryFn: ({ signal }) => listAutomations({ ...ctx, signal }),
    refetchInterval: REFRESH_RUNS_MS,
    retry: false,
  });
  const nameOf = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const a of automations.data ?? []) map.set(a.id, a.name);
    return map;
  }, [automations.data]);
  const recentRuns = runs.data ?? [];

  const presence = agent.data?.presence;
  const agentName = presence ? presenceDisplayName(presence) : null;
  const messages = mail.data?.messages ?? [];
  const unread = messages.filter((m) => !m.seen).length;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface-2 text-fg">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-3">
        <BrandGlyph size={16} />
        <span className="text-[13px] font-semibold tracking-[-0.01em]">
          Boxaide
        </span>
        {/* Working outranks listening: a message in flight is the one thing
            worth catching from the corner of an eye. */}
        <span
          className={cn(
            "ml-auto text-[11px] leading-4",
            presence?.working || agentName
              ? "text-fg-secondary"
              : "text-fg-tertiary",
          )}
        >
          {presence?.working ? "Working" : (agentName ?? "Idle")}
        </span>
      </header>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto">
        {/* Only when there is something to say: an install with no
            automations, or none that has run, gets the mail list alone. */}
        {recentRuns.length > 0 && (
          <section
            aria-label="Recent automation runs"
            className="border-b border-border-subtle"
          >
            <h2 className="px-4 pt-2.5 pb-1 text-[11px] leading-4 font-medium tracking-[0.02em] text-fg-tertiary uppercase">
              Automations
            </h2>
            <ul>
              {recentRuns.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={openInbox}
                    className={cn(
                      "flex w-full items-baseline gap-2 px-4 py-1.5 text-left",
                      "transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "relative top-[-1px] inline-block size-1.5 shrink-0 rounded-full",
                        RUN_DOT[run.status] ?? "bg-fg-tertiary",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-fg-secondary">
                      {nameOf.get(run.automationId) ?? "Automation"}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[11px] leading-4",
                        run.status === "error" || run.status === "killed"
                          ? "text-danger"
                          : "text-fg-tertiary",
                      )}
                    >
                      {runStatusLabel(run.status)}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-fg-tertiary">
                      {formatListDate(run.finishedAt ?? run.startedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!ctx.ready || mail.isPending ? (
          <TrayHint text="Loading your mail…" />
        ) : mail.isError ? (
          <TrayHint text="Boxaide is not reachable." />
        ) : messages.length === 0 ? (
          <TrayHint text="No mail yet." />
        ) : (
          <ul>
            {messages.map((m) => (
              <li key={m.id}>
                {/* A real document navigation, not <Link>: the desktop shell
                    listens for will-navigate and raises the main window
                    instead, which client-side routing would never trigger. */}
                <button
                  type="button"
                  onClick={openInbox}
                  className={cn(
                    "w-full text-left",
                    "flex flex-col gap-0.5 px-4 py-2",
                    "border-b border-border-subtle/60 last:border-b-0",
                    "transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover",
                  )}
                >
                  <span className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[13px] leading-[18px]",
                        m.seen ? "text-fg-secondary" : "font-semibold text-fg",
                      )}
                    >
                      {displayName(m.from) || m.from || "(unknown sender)"}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-fg-tertiary">
                      {formatListDate(m.date)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "truncate text-[12px] leading-4",
                      m.seen ? "text-fg-tertiary" : "text-fg-secondary",
                    )}
                  >
                    {!m.seen && (
                      <span
                        aria-label="unread"
                        className="mr-1.5 inline-block size-1.5 rounded-full bg-accent-fill align-middle"
                      />
                    )}
                    {m.subject}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-2.5">
        <span className="text-[11px] text-fg-tertiary">
          {mail.isSuccess &&
            (unread === 0 ? "All read" : `${unread} unread`)}
        </span>
        <button
          type="button"
          onClick={openInbox}
          className={cn(
            "ml-auto rounded-[var(--radius-md)] bg-accent-fill px-2.5 py-1",
            "text-[12px] font-medium text-accent-fill-fg",
            "transition-opacity duration-[var(--dur-fast)] hover:opacity-90",
          )}
        >
          Open Boxaide
        </button>
      </footer>
    </div>
  );
}

function TrayHint({ text }: { text: string }) {
  return (
    <p className="px-4 py-6 text-center text-[12px] text-fg-tertiary">{text}</p>
  );
}

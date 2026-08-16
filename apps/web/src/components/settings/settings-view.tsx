"use client";

import * as React from "react";
import {
  ArrowUpCircle,
  Info,
  Menu,
  Palette,
  Plug,
  Server,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  AboutPanel,
  AgentsPanel,
  AppearancePanel,
  ConnectionPanel,
  GeneralPanel,
} from "@/components/settings/settings-panels";
import { UpdatesPanel } from "@/components/settings/updates-panel";
import { Button } from "@/components/ui/button";
import {
  SETTINGS_SECTIONS,
  useApp,
  type SettingsSection,
} from "@/lib/hooks/use-app-state";
import { hasUpdateNews, useUpdate } from "@/lib/hooks/use-update";
import { cn } from "@/lib/utils";

/**
 * Settings, as a page.
 *
 * It used to be a 560px dialog with every control stacked in it: server, then
 * workspace, then theme, then MCP, then setup. A dialog is the wrong container
 * for that — it cannot be linked to, it cannot be left open beside the thing it
 * configures, and the one section a person opens it for is three scrolls down.
 *
 * So it is a view with its own sidebar, one section per row, and each section
 * is a URL: `#/settings/updates` is what the desktop app's "Check for updates…"
 * opens, and what a support answer can point at.
 */

type Row = { id: SettingsSection; label: string; icon: LucideIcon };

const ROWS: Record<SettingsSection, Row> = {
  general: { id: "general", label: "General", icon: SlidersHorizontal },
  connection: { id: "connection", label: "Connection", icon: Server },
  agents: { id: "agents", label: "Agents", icon: Plug },
  appearance: { id: "appearance", label: "Appearance", icon: Palette },
  updates: { id: "updates", label: "Updates", icon: ArrowUpCircle },
  about: { id: "about", label: "About", icon: Info },
};

export function SettingsView({
  onOpenRail,
  showRailButton,
}: {
  onOpenRail: () => void;
  showRailButton: boolean;
}) {
  const app = useApp();
  const update = useUpdate();
  const section = app.settingsSection ?? "general";
  /* The same rule the rail card follows: a dot only for an update that can be
     acted on. "Up to date" is not news and a failed check is not news. */
  const updateNews = hasUpdateNews(update.state);

  const refs = React.useRef(new Map<SettingsSection, HTMLButtonElement>());
  const index = SETTINGS_SECTIONS.indexOf(section);

  /* A real APG-style vertical menu: one tab stop, arrows walk the rows. */
  const move = (delta: number) => {
    const next =
      SETTINGS_SECTIONS[
        (index + delta + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
      ];
    app.openSettingsSection(next);
    refs.current.get(next)?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
        {showRailButton && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open mailboxes and folders"
            onClick={onOpenRail}
          >
            <Menu className="size-4" strokeWidth={1.5} />
          </Button>
        )}
        <h2 className="text-[13px] font-medium text-fg">Settings</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close settings"
          className="ml-auto"
          onClick={app.closeSettings}
        >
          <X className="size-4" strokeWidth={1.5} />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label="Settings sections"
          className="shrink-0 border-b border-border-subtle p-2 sm:w-[200px] sm:border-r sm:border-b-0"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowRight") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
              event.preventDefault();
              move(-1);
            }
          }}
        >
          {/* Horizontal scroll below 640px, where the sidebar becomes a strip
              above the panel rather than a column beside it. */}
          <ul className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
            {SETTINGS_SECTIONS.map((id) => {
              const row = ROWS[id];
              const Icon = row.icon;
              const active = id === section;
              return (
                <li key={id}>
                  <button
                    ref={(node) => {
                      if (node) refs.current.set(id, node);
                      else refs.current.delete(id);
                    }}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    tabIndex={active ? 0 : -1}
                    onClick={() => app.openSettingsSection(id)}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-[var(--radius-md)] px-2 text-[13px] whitespace-nowrap",
                      active
                        ? "bg-surface-selected font-medium text-fg"
                        : "text-fg-secondary hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className={cn("size-4 shrink-0", active ? "text-fg" : "text-fg-tertiary")}
                      strokeWidth={1.5}
                    />
                    {row.label}
                    {id === "updates" && updateNews && (
                      <span
                        aria-hidden="true"
                        className="ml-auto size-1.5 rounded-[var(--radius-full)] bg-accent-fill"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="pane-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[620px] px-5 py-6 pb-12">
            <Panel
              section={section}
              focus={app.settingsFocus}
              autoTest={app.settingsAutoTest}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Panel({
  section,
  focus,
  autoTest,
}: {
  section: SettingsSection;
  focus: "baseUrl" | "token" | null;
  autoTest: number | null;
}) {
  switch (section) {
    case "connection":
      return <ConnectionPanel focus={focus} autoTest={autoTest} />;
    case "agents":
      return <AgentsPanel />;
    case "appearance":
      return <AppearancePanel />;
    case "updates":
      return <UpdatesPanel />;
    case "about":
      return <AboutPanel />;
    case "general":
      return <GeneralPanel />;
  }
}

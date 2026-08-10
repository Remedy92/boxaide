"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ThemeChoice = "system" | "light" | "dark";

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const ICON: Record<ThemeChoice, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/**
 * "Has this hydrated yet?" as an external store rather than a setState in an
 * effect. The server snapshot is false, the client snapshot is true, and React
 * swaps them after hydration without a cascading render.
 */
const NO_OP_SUBSCRIBE = () => () => {};
const CLIENT = () => true;
const SERVER = () => false;

/**
 * §4.4. Three-state cycle: system → light → dark → system.
 *
 * Before mount it renders an empty box of the same size. Rendering an icon
 * would make the prerendered HTML claim a theme the user never chose, and
 * useTheme().theme is `undefined` until then anyway.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = React.useSyncExternalStore(NO_OP_SUBSCRIBE, CLIENT, SERVER);

  if (!mounted) {
    return <span aria-hidden="true" className="inline-block size-7" />;
  }

  const current: ThemeChoice =
    theme === "light" || theme === "dark" ? theme : "system";
  const Icon = ICON[current];
  const label = `Theme: ${current}. Change theme.`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          onClick={() => setTheme(NEXT[current])}
          className="text-fg-tertiary hover:text-fg-secondary"
        >
          <Icon className="size-4" strokeWidth={1.5} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Theme — {current}</TooltipContent>
    </Tooltip>
  );
}

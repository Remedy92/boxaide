"use client";

import { BrandGlyph } from "@/components/atoms";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * §6.2 row 1. The FIXTURE badge is truthful and load-bearing: `GET /health`
 * returns `fixture: true` only when the server was started with --fixture, and
 * then every message on screen is demo data.
 */
export function BrandMark({
  fixture,
  collapsed = false,
}: {
  fixture: boolean;
  collapsed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-12 items-center gap-2",
        collapsed && "justify-center",
      )}
    >
      <BrandGlyph className="text-fg" />
      {!collapsed && (
        <>
          <span className="text-[13px] font-semibold tracking-[var(--tracking-tight)] text-fg">
            mailmux
          </span>
          {fixture && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="warning" className="rounded-[var(--radius-xs)] px-1.5">
                  FIXTURE
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                This server is running with --fixture. Every message on screen is
                demo data.
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}
    </div>
  );
}

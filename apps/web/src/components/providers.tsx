"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors";
import { adoptLegacyTheme, SETTINGS_KEYS } from "@/lib/settings";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

adoptLegacyTheme();

export function Providers({ children }: { children: React.ReactNode }) {
  // useState so a single client survives every re-render.
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: (count, err) => {
              // Never retry auth or origin rejections — they will not fix
              // themselves, and retrying burns the user's server log with
              // failures. The check is on ApiError.kind, not on the message:
              // friendlyError() rewrites the text, so a string match would
              // silently stop matching.
              if (err instanceof ApiError) {
                if (err.kind === "unauthorized" || err.kind === "forbidden-origin") {
                  return false;
                }
                if (err.status === 400 || err.status === 404) return false;
              }
              return count < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        storageKey={SETTINGS_KEYS.theme}
      >
        <TooltipProvider delayDuration={400} skipDelayDuration={200}>
          {children}
        </TooltipProvider>
        <Toaster position="bottom-right" closeButton richColors={false} />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

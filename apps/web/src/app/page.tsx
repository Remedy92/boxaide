"use client";

import { AppShell } from "@/components/app-shell";

/**
 * Inbox at `/`. Sister routes: `/app`, `/install`, `/tray`.
 * `output: 'export'` bans dynamic routes without generateStaticParams,
 * and message ids are unknowable at build time, so selection lives in
 * React state mirrored to the URL hash (§2.7).
 */
export default function Page() {
  return <AppShell />;
}

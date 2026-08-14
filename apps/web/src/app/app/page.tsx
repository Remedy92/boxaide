"use client";

import { AppShell } from "@/components/app-shell";

/**
 * The inbox, at a second address.
 *
 * `/` is the same screen and stays the canonical one: that is what the local
 * server hands you on 127.0.0.1:8787 and what the desktop window opens. This
 * route exists for the deployed copy of this app, where `/` redirects to the
 * download page — a stranger who lands on the domain has nothing to type into
 * a "server URL and token" form yet, and the page they need is the one that
 * gives them Boxaide. See the redirect in vercel.json.
 *
 * It renders the identical component, so there is no second implementation to
 * keep in step; the export just writes the same screen to app/index.html.
 */
export default function AppRoute() {
  return <AppShell />;
}

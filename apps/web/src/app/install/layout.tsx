import type { Metadata } from "next";

/**
 * The install page is the only route with its own metadata: `/` is the app and
 * titles itself "Boxaide", while this one is the page a stranger lands on.
 * A layout carries it because the page itself is a client component.
 */
export const metadata: Metadata = {
  title: "Boxaide — every mailbox, one inbox",
  description:
    "Gmail, Outlook, iCloud and work mail in one window on your own computer. Free, open source, and every agent you use can read it over MCP.",
  openGraph: {
    type: "website",
    title: "Boxaide — every mailbox, one inbox",
    description:
      "Gmail, Outlook, iCloud and work mail in one window on your own computer. Free and open source.",
  },
};

export default function InstallLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

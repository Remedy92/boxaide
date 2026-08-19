import type { Metadata } from "next";

/**
 * The install page is the only route with its own metadata: `/` is the app and
 * titles itself "Boxaide", while this one is the page a stranger lands on.
 * A layout carries it because the page itself is a client component.
 */
export const metadata: Metadata = {
  title: "Boxaide: every mailbox, one agent",
  description:
    "Connect as many mailboxes as you want, then point every agent on your machine at all of them. A CRM, scheduled runs and an outreach queue, all on your own computer. Free and open source.",
  openGraph: {
    type: "website",
    title: "Boxaide: every mailbox, one agent",
    description:
      "Connect as many mailboxes as you want, then point every agent on your machine at all of them. Free, open source, and it never leaves your computer.",
  },
};

export default function InstallLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

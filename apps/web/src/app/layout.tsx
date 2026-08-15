import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

/**
 * One family, four weights, self-hosted.
 *
 * next/font downloads Inter at BUILD time and emits the woff2 into
 * `_next/static/media`, so the running page fetches nothing from a third-party
 * origin — which the CSP (`font-src 'self' data:`) would block anyway. There is
 * no second web font: code and tokens use the operating system's own monospace
 * stack, declared in globals.css.
 */
const sans = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Boxaide",
  description: "Your mailboxes, on your machine.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning silences exactly one thing: next-themes' blocking
    // script stamps class="dark" on <html> before hydration, which React would
    // otherwise report as a mismatch. It does not hide any other warning.
    <html lang="en" suppressHydrationWarning className={sans.variable}>
      <head>
        {/* The desktop window hides its title bar on macOS and lets the page
            own the strip the traffic lights sit in. Stamped by a blocking
            script rather than an effect: an effect runs after first paint, and
            the lights would land on the brand row for a frame. No IPC and no
            preload — the signal is a marker that window appends to its own
            user agent, in apps/desktop/src/main.js. */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html:
              "try{if(/BoxaideDesktop\\//.test(navigator.userAgent))document.documentElement.dataset.desktop='mac'}catch(e){}",
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

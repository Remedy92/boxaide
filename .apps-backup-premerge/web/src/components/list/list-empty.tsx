"use client";

import * as React from "react";
import {
  CircleAlert,
  Inbox,
  KeyRound,
  MailOpen,
  Search,
  Server,
  ShieldAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { TechnicalDetails } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/api/errors";
import type { ConnectionState as Connection } from "@/lib/hooks/use-connection";
import { copyToClipboard } from "@/lib/utils";

/**
 * §7. Every state the list can be in that is not "here is your mail", with the
 * copy the spec fixes. The order below matters: the first match wins, so a
 * server that is unreachable never also claims the token is wrong.
 */

function Block({
  icon: Icon,
  tone = "muted",
  headline,
  children,
  actions,
}: {
  icon: LucideIcon;
  tone?: "muted" | "danger";
  headline: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center px-5 py-6">
      <div className="max-w-[280px] text-center">
        <Icon
          aria-hidden="true"
          className={`mx-auto size-5 ${
            tone === "danger" ? "text-danger" : "text-fg-tertiary"
          }`}
          strokeWidth={1.5}
        />
        <h2 className="mt-3 text-[14px] leading-5 font-medium text-fg">
          {headline}
        </h2>
        <div className="mt-1 text-[13px] leading-[18px] text-fg-secondary">
          {children}
        </div>
        {actions && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}

/** Only what ConnectionStateBlock actually dispatches. */
export type ListStateHandlers = {
  openSettings: (focus?: "baseUrl" | "token") => void;
  retry: () => void;
};

/** §7.1 — first run on a fresh browser. No request is made. */
export function NoBaseUrlState({ onSetUp }: { onSetUp: () => void }) {
  return (
    <Block icon={Server} headline="Point mailmux at your server">
      <p>
        Run <code className="font-mono text-[12px]">mailmux serve</code> on your
        machine, then tell this page where to find it.
      </p>
      <div className="mt-4">
        <Button type="button" onClick={onSetUp}>
          Set up mailmux
        </Button>
      </div>
    </Block>
  );
}

/** §7.2 — transport rejection or an 8s timeout on GET /health. */
export function UnreachableState({
  host,
  raw,
  onRetry,
  onChangeUrl,
}: {
  host: string;
  raw: string;
  onRetry: () => void;
  onChangeUrl: () => void;
}) {
  return (
    <Block
      icon={CircleAlert}
      tone="danger"
      headline={`Can't reach ${host}`}
      actions={
        <>
          <Button type="button" onClick={onRetry}>
            Try again
          </Button>
          <Button type="button" variant="secondary" onClick={onChangeUrl}>
            Change server URL
          </Button>
        </>
      }
    >
      <p>
        Check that <code className="font-mono text-[12px]">mailmux serve</code>{" "}
        is running, and that the URL and port match what it printed.
      </p>
      <TechnicalDetails raw={raw} />
    </Block>
  );
}

/** §7.3 — GET /api/health returned 401. Never retried. */
export function UnauthorizedState({
  tokenHint,
  onEnterToken,
}: {
  tokenHint?: string;
  onEnterToken: () => void;
}) {
  return (
    <Block
      icon={KeyRound}
      tone="danger"
      headline="Your server rejected this token"
      actions={
        <Button type="button" onClick={onEnterToken}>
          Enter token
        </Button>
      }
    >
      <p>
        Copy the token <code className="font-mono text-[12px]">mailmux serve</code>{" "}
        printed, or read it from{" "}
        <code className="font-mono text-[12px]">bearer.token</code> in your data
        directory.
      </p>
      {tokenHint && (
        <p className="mt-2 font-mono text-[12px] text-fg-tertiary">
          Server expects a token starting {tokenHint}
        </p>
      )}
    </Block>
  );
}

/** §7.3, before any request: a URL is set but no token is. */
export function NoTokenState({ onEnterToken }: { onEnterToken: () => void }) {
  return (
    <Block
      icon={KeyRound}
      headline="Add your access token"
      actions={
        <Button type="button" onClick={onEnterToken}>
          Enter token
        </Button>
      }
    >
      <p>
        Copy the token <code className="font-mono text-[12px]">mailmux serve</code>{" "}
        printed, or read it from{" "}
        <code className="font-mono text-[12px]">bearer.token</code> in your data
        directory.
      </p>
    </Block>
  );
}

/** §7.4 — CORS: the server has not allowlisted this origin. */
export function CorsBlockedState() {
  const line = "MAILMUX_ALLOWED_ORIGINS=https://your-deployment.vercel.app";
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const real = `MAILMUX_ALLOWED_ORIGINS=${origin || "https://your-deployment.vercel.app"}`;
  return (
    <Block
      icon={ShieldAlert}
      tone="danger"
      headline="Your server refused this page's origin"
      actions={
        <Button
          type="button"
          onClick={async () => {
            const ok = await copyToClipboard(real);
            toast[ok ? "success" : "warning"](
              ok ? "Copied the line" : "Press ⌘C to copy",
            );
          }}
        >
          Copy the line
        </Button>
      }
    >
      <p>
        mailmux only accepts browser requests from your own machine unless you
        allow this address. On the machine running mailmux, set:
      </p>
      <pre className="mt-2 overflow-x-auto rounded-[var(--radius-md)] bg-surface-0 p-2 text-left font-mono text-[12px] text-fg-secondary">
        {real || line}
      </pre>
      <p className="mt-2">
        then restart <code className="font-mono text-[12px]">mailmux serve</code>.
      </p>
    </Block>
  );
}

/** §7.4 — Chromium 142+ Local Network Access, denied or dismissed. */
export function LnaBlockedState() {
  return (
    <Block
      icon={ShieldAlert}
      tone="danger"
      headline="Your browser blocked the request to your own machine"
      actions={
        <Button type="button" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    >
      <p>
        Chrome asks permission before a website may talk to{" "}
        <code className="font-mono text-[12px]">127.0.0.1</code>. Allow it, then
        reload. If you dismissed the prompt, re-enable it in Site settings →{" "}
        <em>Apps on device</em>.
      </p>
    </Block>
  );
}

/**
 * §7.4 — WebKit's loopback block, and the general https-page-to-http-host case.
 * The second button is a real link to the local build, which genuinely works.
 */
export function MixedContentState({ baseUrl }: { baseUrl: string }) {
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)(:|\/|$)/i.test(
    baseUrl,
  );
  if (loopback) {
    return (
      <Block
        icon={ShieldAlert}
        tone="danger"
        headline="Safari won't let an https page reach 127.0.0.1"
        actions={
          <Button asChild type="button">
            <a href={baseUrl} target="_blank" rel="noopener noreferrer">
              Open the local build
            </a>
          </Button>
        }
      >
        <p>
          This is a WebKit limitation with no workaround. Open mailmux directly
          at <code className="font-mono text-[12px]">{baseUrl}</code> instead —
          it serves the same interface from your own machine.
        </p>
      </Block>
    );
  }
  return (
    <Block
      icon={ShieldAlert}
      tone="danger"
      headline="Your browser blocked this connection"
      actions={
        <Button asChild type="button">
          <a href={baseUrl} target="_blank" rel="noopener noreferrer">
            Open the local build
          </a>
        </Button>
      }
    >
      <p>
        Browsers block http requests from an https page unless the address is
        127.0.0.1 or localhost. Use a loopback address, or put your server behind
        https.
      </p>
    </Block>
  );
}

/** §7.5 — the server answers and has no mailboxes. */
export function NoAccountsState({ onConnect }: { onConnect: () => void }) {
  return (
    <Block
      icon={Inbox}
      headline="No mailboxes yet"
      actions={
        <Button type="button" onClick={onConnect}>
          Connect a mailbox
        </Button>
      }
    >
      <p>
        Connect one and mailmux starts fetching. Credentials are encrypted and
        stay on your machine.
      </p>
    </Block>
  );
}

/**
 * A healthy listing that came back with no rows. The spec fixes no copy for
 * this case; the wording below states only what the request actually asked for.
 */
export function NoMessagesState({
  unreadOnly,
  folder,
  onShowAll,
}: {
  unreadOnly: boolean;
  folder?: string;
  onShowAll: () => void;
}) {
  const filtered = unreadOnly || !!folder;
  return (
    <Block
      icon={unreadOnly ? MailOpen : Inbox}
      headline={unreadOnly ? "Nothing unread" : "Nothing here"}
      actions={
        filtered ? (
          <Button type="button" variant="secondary" onClick={onShowAll}>
            Show all mail
          </Button>
        ) : undefined
      }
    >
      <p>
        {unreadOnly
          ? "Every message this listing returned has been read."
          : folder
            ? "That folder returned no messages."
            : "This mailbox returned no messages."}
      </p>
    </Block>
  );
}

/** A search that came back empty. Search always runs against Inbox. */
export function NoResultsState({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <Block
      icon={Search}
      headline="No matches"
      actions={
        <Button type="button" variant="secondary" onClick={onClear}>
          Clear search
        </Button>
      }
    >
      <p>
        Nothing in Inbox matched “{query}”. Your mail server runs this search, so
        what it matches varies by provider.
      </p>
    </Block>
  );
}

/** The whole request failed — as opposed to a partial `errors[]` (§7.6). */
export function RequestErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return (
    <Block
      icon={CircleAlert}
      tone="danger"
      headline="That request failed"
      actions={
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      <p>{friendlyError(raw)}</p>
      <TechnicalDetails raw={raw} />
    </Block>
  );
}

/** Dispatch on the resolved connection state; returns null when all is well. */
export function ConnectionStateBlock({
  connection,
  tokenHint,
  baseUrl,
  handlers,
}: {
  connection: Connection;
  tokenHint?: string;
  baseUrl: string;
  handlers: ListStateHandlers;
}) {
  switch (connection.kind) {
    case "no-base-url":
      return <NoBaseUrlState onSetUp={() => handlers.openSettings("baseUrl")} />;
    case "unreachable":
      return (
        <UnreachableState
          host={connection.host}
          raw={connection.raw}
          onRetry={handlers.retry}
          onChangeUrl={() => handlers.openSettings("baseUrl")}
        />
      );
    case "blocked":
      if (connection.failure === "lna-denied") return <LnaBlockedState />;
      if (connection.failure === "mixed-content")
        return <MixedContentState baseUrl={baseUrl} />;
      return <CorsBlockedState />;
    case "no-token":
      return <NoTokenState onEnterToken={() => handlers.openSettings("token")} />;
    case "unauthorized":
      return (
        <UnauthorizedState
          tokenHint={tokenHint}
          onEnterToken={() => handlers.openSettings("token")}
        />
      );
    case "ok":
      return null;
  }
}

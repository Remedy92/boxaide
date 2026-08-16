"use client";

import * as React from "react";
import { ArrowUpCircle, CheckCircle2, ExternalLink, RotateCw, TriangleAlert } from "lucide-react";
import { Spinner } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { useUpdate } from "@/lib/hooks/use-update";
import type { UpdateState } from "@/lib/types";

/**
 * Settings → Updates. The one page that answers "am I on the newest Boxaide",
 * and the page the desktop app's "Check for updates…" opens.
 *
 * The rail card next door is deliberately quiet: it appears only when there is
 * something to act on. This page is the opposite — it always states the
 * version, the channel and the time of the last check, because somebody who
 * opened it is asking. A check pressed here starts the download when it finds
 * one; the server does that, so the button is never a check that leaves a
 * second button to find.
 */
/** A check that ran this recently is the answer this page would get anyway. */
const FRESH_MS = 60_000;

export function UpdatesPanel() {
  const update = useUpdate();
  const state = update.state;

  /* Opening this page IS asking. The palette row is labelled "Check for
     updates" and the desktop menu item opens it, so a page that showed a
     stale answer and waited to be pressed would be the same do-nothing
     button this replaced. Once per mount, and never over a check that just
     ran or a download in flight. */
  const checkRef = React.useRef(update.check);
  React.useEffect(() => {
    checkRef.current = update.check;
  });
  const asked = React.useRef(false);
  React.useEffect(() => {
    if (asked.current || !state) return;
    if (state.status === "checking" || state.status === "downloading") return;
    if (state.status === "ready") return;
    const at = state.checkedAt ? Date.parse(state.checkedAt) : NaN;
    if (Number.isFinite(at) && Date.now() - at < FRESH_MS) {
      asked.current = true;
      return;
    }
    asked.current = true;
    checkRef.current();
  }, [state]);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-[15px] leading-5 font-medium text-fg">Updates</h2>
        <p className="text-[13px] leading-[18px] text-fg-secondary">
          Boxaide checks for a new version when it starts, and every six hours
          after that.
        </p>
      </header>

      {state === null ? (
        <p className="text-[13px] leading-[18px] text-fg-tertiary">
          This server does not report updates. It is either older than the
          update endpoint, or not reachable right now.
        </p>
      ) : (
        <Panel state={state} update={update} />
      )}
    </div>
  );
}

function Panel({
  state,
  update,
}: {
  state: UpdateState;
  update: ReturnType<typeof useUpdate>;
}) {
  const checking = state.status === "checking" || update.busy;

  return (
    <>
      <section className="rounded-[var(--radius-lg)] border border-border-subtle bg-surface-1 p-4">
        <div className="flex items-start gap-3">
          <StatusIcon status={state.status} />
          <div className="min-w-0 flex-1">
            {/* Polite: the answer to a button press the user is watching for,
                never worth cutting off what the screen reader is saying. */}
            <p role="status" aria-live="polite" className="text-[14px] leading-5 font-medium text-fg">
              {headline(state)}
            </p>
            <p className="mt-0.5 text-[13px] leading-[18px] text-fg-secondary">
              {subline(state)}
            </p>
          </div>
        </div>

        {state.status === "downloading" && (
          <Progress className="mt-3" value={state.progress} />
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={state.status === "ready" || state.status === "available" ? "secondary" : "default"}
            disabled={checking}
            aria-busy={checking || undefined}
            onClick={update.check}
          >
            {checking && <Spinner />}
            {checking ? "Checking…" : "Check for updates"}
          </Button>

          {state.canInstall && state.status === "available" && (
            <Button
              type="button"
              disabled={update.busy}
              onClick={update.download}
            >
              Download update
            </Button>
          )}

          {state.canInstall && state.status === "ready" && (
            <Button type="button" disabled={update.busy} onClick={update.install}>
              <RotateCw className="size-3.5" strokeWidth={1.5} />
              Restart now
            </Button>
          )}

          {state.releaseUrl && (
            <a
              href={state.releaseUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[13px] leading-[18px] text-accent hover:text-[var(--accent-hover)]"
            >
              Release page
              <ExternalLink aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
            </a>
          )}
        </div>

        {/* An error under the offer, never instead of one: an update that was
            already found is still there when a later check fails. */}
        {state.error && (
          <p className="mt-2 text-[12px] leading-4 text-warning">{state.error}</p>
        )}
        {update.commandError && (
          <p className="mt-2 text-[12px] leading-4 text-warning">
            {update.commandError}
          </p>
        )}
      </section>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px] leading-[18px]">
        <dt className="text-fg-tertiary">Installed</dt>
        <dd className="tnum text-fg">{state.currentVersion}</dd>
        <dt className="text-fg-tertiary">Latest</dt>
        <dd className="tnum text-fg">{state.latestVersion ?? "Unknown"}</dd>
        <dt className="text-fg-tertiary">Last checked</dt>
        <dd className="text-fg">{checkedLabel(state.checkedAt)}</dd>
        <dt className="text-fg-tertiary">How it updates</dt>
        <dd className="text-fg">
          {state.channel === "auto"
            ? "This app downloads and installs updates itself."
            : "This server is updated with npm or git, by whoever runs it."}
        </dd>
      </dl>

      {state.notes && (
        <section className="space-y-1.5">
          <h3 className="text-[13px] font-medium text-fg">
            What is new in {state.latestVersion}
          </h3>
          {/* The release body as written, not rendered: it is somebody's
              markdown, and rendering it would be a second markdown pipeline
              in the app for one paragraph of changelog. */}
          <div className="pane-scroll max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-border-subtle p-3">
            <p className="text-[13px] leading-[18px] whitespace-pre-wrap text-fg-secondary">
              {state.notes}
            </p>
          </div>
        </section>
      )}
    </>
  );
}

function StatusIcon({ status }: { status: UpdateState["status"] }) {
  if (status === "checking") {
    return (
      <span className="mt-0.5 flex size-5 items-center justify-center">
        <Spinner />
      </span>
    );
  }
  if (status === "error") {
    return (
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-5 shrink-0 text-warning"
        strokeWidth={1.5}
      />
    );
  }
  if (status === "up-to-date") {
    return (
      <CheckCircle2
        aria-hidden="true"
        className="mt-0.5 size-5 shrink-0 text-success"
        strokeWidth={1.5}
      />
    );
  }
  return (
    <ArrowUpCircle
      aria-hidden="true"
      className="mt-0.5 size-5 shrink-0 text-accent"
      strokeWidth={1.5}
    />
  );
}

/** A determinate bar — electron-updater reports real bytes. */
function Progress({ value, className = "" }: { value: number | null; className?: string }) {
  const percent = Math.round(Math.min(Math.max(value ?? 0, 0), 1) * 100);
  return (
    <div className={`space-y-1 ${className}`}>
      <div
        role="progressbar"
        aria-label="Downloading the update"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-[var(--radius-full)] bg-[var(--accent-line)]"
      >
        <div
          className="h-full rounded-[var(--radius-full)] bg-accent-fill transition-[width] duration-[var(--dur-enter)] ease-linear"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="tnum text-[12px] leading-4 text-fg-tertiary">{percent}% downloaded</p>
    </div>
  );
}

export function headline(state: UpdateState): string {
  const version = state.latestVersion ?? "A new version";
  switch (state.status) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading Boxaide ${version}`;
    case "ready":
      return `Boxaide ${version} is ready to install`;
    case "available":
      return `Boxaide ${version} is available`;
    case "up-to-date":
      return "Boxaide is up to date";
    case "error":
      return "The last check did not finish";
    case "idle":
      return "No check has run yet";
  }
}

function subline(state: UpdateState): string {
  switch (state.status) {
    case "ready":
      return "Restart to finish. Your mailboxes and drafts are untouched.";
    case "downloading":
      return "You can keep working. Boxaide will ask to restart when it lands.";
    case "available":
      return state.canInstall
        ? `You are on ${state.currentVersion}. The download starts when you press Download update.`
        : `You are on ${state.currentVersion}. Update with npm or git to get it.`;
    case "up-to-date":
      return `You are on ${state.currentVersion}, the newest release.`;
    case "error":
      return `You are on ${state.currentVersion}. Nothing has changed — try again.`;
    default:
      return `You are on ${state.currentVersion}.`;
  }
}

/** Absolute for anything older than today; nobody counts hours past that. */
function checkedLabel(iso: string | null): string {
  if (!iso) return "Not yet this session";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "Not yet this session";
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (minutes < 60 * 24) {
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return at.toLocaleString();
}

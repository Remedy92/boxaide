/**
 * One place that knows whether a newer Boxaide exists, and how far along the
 * download is. Both the desktop app and a self-hosted server read it through
 * `GET /api/update`, so the sidebar renders from the same facts either way.
 *
 * Two channels, one state shape:
 *
 *   auto    the desktop app. A driver (electron-updater, wired in
 *           apps/desktop/src/main.js) owns the truth: it checks the release
 *           feed, downloads the signed build and installs it. This service
 *           holds what the driver reports and forwards the three commands.
 *
 *   manual  `boxaide serve` in a terminal, or any browser pointed at it.
 *           There is nothing to install into — the user runs npm or git — so
 *           the service polls the GitHub release itself and states the version.
 *           `canInstall` is false and the UI offers a link, not a button.
 *
 * The rules that keep it honest are in one place on purpose:
 *   - A version that does not parse is never "an update available".
 *   - A version that is not strictly newer is never "an update available",
 *     so a dev build ahead of the last release stays quiet.
 *   - A failed check never erases an update that was already found. The
 *     error is reported beside it; the offer stands.
 */
import { isNewer } from "./semver.js";
import { appVersion } from "../version.js";

export type UpdateStatus =
  /** Nothing checked yet this run. */
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  /** Downloaded and staged. Installing is a restart away. */
  | "ready"
  | "error";

export type UpdateState = {
  channel: "auto" | "manual";
  status: UpdateStatus;
  currentVersion: string;
  /** The newest version seen, which may equal `currentVersion`. */
  latestVersion: string | null;
  /** Release notes, trimmed and capped. Plain text or markdown. */
  notes: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  /** 0–1 while downloading, null otherwise. */
  progress: number | null;
  /** ISO time of the last check that reached the network. */
  checkedAt: string | null;
  /** Set when the last attempt failed. Never blocks a known update. */
  error: string | null;
  /** True only when this build can install the update itself. */
  canInstall: boolean;
};

/**
 * What the desktop shell implements. Kept to four calls so the Electron side
 * stays a thin adapter over electron-updater and this file needs no Electron.
 */
export type UpdateDriver = {
  /** False for an unpackaged dev run, where installing would replace nothing. */
  canInstall: boolean;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): void;
  /** Called once, before any command, with the sink for driver events. */
  subscribe(emit: (event: DriverEvent) => void): void;
};

export type DriverEvent =
  | { kind: "checking" }
  | {
      kind: "available";
      version: string;
      notes?: string | null;
      publishedAt?: string | null;
    }
  | { kind: "not-available"; version?: string | null }
  | { kind: "progress"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

export type UpdateOptions = {
  /** Defaults to the running build's package version. */
  currentVersion?: string;
  /** `owner/repo`. */
  repo?: string;
  driver?: UpdateDriver;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/** Six hours. An update is not news that goes stale in minutes. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The launch check. Short enough that the answer is on screen while the user
 * is still looking at a freshly opened window, long enough that it does not
 * compete with the first mailbox refresh for the same socket.
 */
export const FIRST_CHECK_DELAY_MS = 2_000;

/** A release page can hold a very long changelog; the rail shows a summary. */
const MAX_NOTES = 4_000;

const DEFAULT_REPO = "Remedy92/boxaide";
const CHECK_TIMEOUT_MS = 10_000;

type GithubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
};

export class UpdateService {
  readonly channel: "auto" | "manual";
  private readonly repo: string;
  private readonly driver: UpdateDriver | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly current: string;

  private status: UpdateStatus = "idle";
  private latest: string | null = null;
  private notes: string | null = null;
  private releaseUrl: string | null = null;
  private publishedAt: string | null = null;
  private progress: number | null = null;
  private checkedAt: string | null = null;
  private error: string | null = null;

  /** In flight, so two callers share one check instead of racing. */
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: UpdateOptions = {}) {
    this.current = options.currentVersion ?? appVersion();
    this.repo = options.repo ?? DEFAULT_REPO;
    this.driver = options.driver;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.channel = this.driver ? "auto" : "manual";
    this.driver?.subscribe((event) => this.onDriverEvent(event));
  }

  state(): UpdateState {
    return {
      channel: this.channel,
      status: this.status,
      currentVersion: this.current,
      latestVersion: this.latest,
      notes: this.notes,
      releaseUrl: this.releaseUrl,
      publishedAt: this.publishedAt,
      progress: this.progress,
      checkedAt: this.checkedAt,
      error: this.error,
      // An update that is not there cannot be installed, whatever the driver
      // says it is capable of.
      canInstall:
        (this.driver?.canInstall ?? false) &&
        (this.status === "available" ||
          this.status === "downloading" ||
          this.status === "ready"),
    };
  }

  /** Check now, and every six hours. Safe to call twice. */
  start(): void {
    if (this.firstTimer || this.timer) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.check().catch(() => {});
    }, FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => {
      void this.check().catch(() => {});
    }, CHECK_INTERVAL_MS);
    // Neither timer is a reason to keep a process alive.
    this.firstTimer.unref?.();
    this.timer.unref?.();
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }

  /** Ask the release feed. Concurrent callers share the one request. */
  check(): Promise<void> {
    if (this.pending) return this.pending;
    // A download in flight is a check that already succeeded. Re-checking
    // would reset the status the progress bar is drawn from.
    if (this.status === "downloading" || this.status === "ready") {
      return Promise.resolve();
    }
    const run = this.driver ? this.driverCheck() : this.githubCheck();
    this.pending = run.finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /**
   * Check, and start the download the moment the check finds something.
   *
   * This is what a person means by "check for updates": the menu item used to
   * check, say nothing, and leave the download to a button in the sidebar the
   * user had to go and find. Every surface a human presses — the menu bar item
   * and the Check now button in Settings — calls this. The six-hour background
   * timer still calls `check` alone: an unasked-for 100 MB download is the
   * user's call, an asked-for one is not.
   *
   * Never throws. A manual-channel server has nothing to download, and that is
   * an answer ("0.3.0 is out, here is the release"), not a failure.
   */
  async checkAndDownload(): Promise<void> {
    await this.check().catch(() => {});
    if (!this.driver) return;
    if (this.status !== "available") return;
    try {
      this.download();
    } catch {
      // Raced with another caller that already started it. Nothing to report.
    }
  }

  /**
   * Start the download. Auto channel only — there is no file for a
   * self-hosted server to fetch that it could then run.
   *
   * Synchronous on purpose: it validates and flips the state before it
   * returns, so the route that calls it can answer with a state that already
   * says "downloading", and can catch a refusal as a thrown error rather than
   * a rejected promise nobody awaits.
   */
  download(): void {
    if (!this.driver) {
      throw new UpdateUnavailable("This build updates itself through npm or git.");
    }
    if (this.status === "downloading" || this.status === "ready") return;
    if (this.status !== "available") {
      throw new UpdateUnavailable("There is no update to download.");
    }
    this.status = "downloading";
    this.progress = 0;
    this.error = null;
    this.driver.download().catch((err: unknown) => {
      // The driver's own error event usually lands first and says more; this
      // is the backstop for a rejection that never emitted one.
      if (this.status !== "downloading") return;
      this.status = "available";
      this.progress = null;
      this.error = messageOf(err);
    });
  }

  /** Quit and relaunch into the new version. Returns once handed to the driver. */
  install(): void {
    if (!this.driver) throw new UpdateUnavailable("This build updates itself through npm or git.");
    if (this.status !== "ready") {
      throw new UpdateUnavailable("The update is not downloaded yet.");
    }
    this.driver.install();
  }

  /* ---- auto channel ------------------------------------------------------ */

  private async driverCheck(): Promise<void> {
    if (!this.driver) return;
    this.beginCheck();
    try {
      await this.driver.check();
    } catch (err) {
      this.fail(messageOf(err));
    }
  }

  private onDriverEvent(event: DriverEvent): void {
    switch (event.kind) {
      case "checking":
        this.beginCheck();
        return;
      case "available": {
        this.checkedAt = this.now().toISOString();
        this.error = null;
        // The guard that matters: electron-updater will happily report the
        // release it found even when it is the one already running.
        if (!isNewer(event.version, this.current)) {
          this.latest = event.version;
          this.status = "up-to-date";
          return;
        }
        this.latest = event.version;
        this.notes = trimNotes(event.notes);
        this.publishedAt = asIsoOrNull(event.publishedAt);
        this.releaseUrl = this.tagUrl(event.version);
        // A download already running or finished outranks a fresh "available"
        // for the same version, which is what a manual re-check emits.
        if (this.status !== "downloading" && this.status !== "ready") {
          this.status = "available";
          this.progress = null;
        }
        return;
      }
      case "not-available":
        this.checkedAt = this.now().toISOString();
        this.error = null;
        this.latest = event.version ?? this.current;
        this.status = "up-to-date";
        this.progress = null;
        return;
      case "progress":
        // Progress for a download this service did not start still means one
        // is running; showing it is more honest than dropping it.
        this.status = "downloading";
        this.progress = clampFraction(event.percent / 100);
        return;
      case "downloaded":
        this.latest = event.version;
        this.status = "ready";
        this.progress = 1;
        this.error = null;
        return;
      case "error":
        this.fail(event.message);
        return;
    }
  }

  /* ---- manual channel ---------------------------------------------------- */

  private async githubCheck(): Promise<void> {
    this.beginCheck();
    let release: GithubRelease;
    try {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${this.repo}/releases/latest`,
        {
          headers: {
            accept: "application/vnd.github+json",
            // GitHub rejects an API request with no user agent.
            "user-agent": `boxaide/${this.current}`,
          },
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        this.fail(
          response.status === 403 || response.status === 429
            ? "GitHub is rate-limiting update checks. It will try again later."
            : `The release feed answered ${response.status}.`,
        );
        return;
      }
      release = (await response.json()) as GithubRelease;
    } catch (err) {
      // Offline is the common case here and is not worth alarming about; the
      // UI shows the last known answer and this line only if it is asked for.
      this.fail(messageOf(err));
      return;
    }

    const tag = typeof release.tag_name === "string" ? release.tag_name : null;
    const version = tag ? tag.replace(/^v/, "") : null;
    this.checkedAt = this.now().toISOString();
    this.error = null;
    if (!isNewer(version, this.current)) {
      this.latest = version ?? this.current;
      this.status = "up-to-date";
      return;
    }
    this.latest = version;
    this.notes = trimNotes(release.body);
    this.publishedAt = asIsoOrNull(release.published_at);
    this.releaseUrl =
      typeof release.html_url === "string"
        ? release.html_url
        : this.tagUrl(version as string);
    this.status = "available";
    this.progress = null;
  }

  /* ---- shared ------------------------------------------------------------ */

  /**
   * Enter "checking" — unless an update is already on offer.
   *
   * The rail draws its card from `status` alone, so blanking a known
   * "available" for the length of a round trip takes the card off screen and
   * puts it back. The six-hour timer does that unprompted, and the tray's
   * "Check for updates…" does it at the very moment it opens the window to
   * show the answer. A check that confirms what is already known changes
   * nothing the user should watch happen.
   */
  private beginCheck(): void {
    if (this.status === "available") return;
    this.status = "checking";
  }

  /**
   * Record a failure without losing ground. An update already found stays
   * found: the user can still act on it, and the next check will confirm it.
   */
  private fail(message: string): void {
    this.error = message;
    // A downloaded update is still installable whatever just failed.
    if (this.status === "ready") return;
    this.progress = null;
    // The test that keeps this honest: a check that starts sets `checking`,
    // so a failure a moment later must not be allowed to leave the state at
    // "error" while a perfectly good newer version is sitting in `latest`.
    // The bytes of a failed download are gone; the offer is not.
    if (isNewer(this.latest, this.current)) {
      this.status = "available";
      return;
    }
    this.status = "error";
  }

  private tagUrl(version: string): string {
    return `https://github.com/${this.repo}/releases/tag/v${version}`;
  }
}

/** A command that does not apply to this build or this state. Answered 409. */
export class UpdateUnavailable extends Error {}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function trimNotes(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text.length <= MAX_NOTES) return text;
  return `${text.slice(0, MAX_NOTES).trimEnd()}…`;
}

function asIsoOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { compareVersions, isNewer, parseVersion } from "../src/update/semver.js";
import { registerUpdateRoutes } from "../src/update/routes.js";
import {
  UpdateService,
  type DriverEvent,
  type UpdateDriver,
} from "../src/update/service.js";

describe("parseVersion", () => {
  it("takes a release tag with or without the v", () => {
    expect(parseVersion("v0.2.9")).toEqual({
      major: 0,
      minor: 2,
      patch: 9,
      pre: [],
    });
    expect(parseVersion("0.2.9")?.patch).toBe(9);
  });

  it("keeps prerelease identifiers and drops build metadata", () => {
    expect(parseVersion("1.0.0-rc.2+abc123")?.pre).toEqual(["rc", "2"]);
  });

  it("rejects anything that is not a version", () => {
    for (const raw of ["", "latest", "1.2", "1.2.3.4", "1.0.0-", "1.0.0-a..b"]) {
      expect(parseVersion(raw), raw).toBeNull();
    }
  });
});

describe("compareVersions", () => {
  const order = ["0.2.9", "0.3.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-rc.1", "1.0.0", "1.0.1"];

  it("sorts the semver precedence example", () => {
    const shuffled = [...order].reverse();
    shuffled.sort((a, b) => compareVersions(parseVersion(a)!, parseVersion(b)!));
    expect(shuffled).toEqual(order);
  });

  it("ranks a numeric prerelease identifier below an alphanumeric one", () => {
    expect(
      compareVersions(parseVersion("1.0.0-1")!, parseVersion("1.0.0-alpha")!),
    ).toBe(-1);
  });
});

describe("isNewer", () => {
  it("is true only for a strictly higher version", () => {
    expect(isNewer("0.3.0", "0.2.9")).toBe(true);
    expect(isNewer("0.2.9", "0.2.9")).toBe(false);
    // The case that matters most: a dev build ahead of the last release must
    // never be told to "update" back to it.
    expect(isNewer("0.2.9", "0.3.0")).toBe(false);
  });

  it("is false when either side does not parse", () => {
    expect(isNewer("nightly", "0.2.9")).toBe(false);
    expect(isNewer("0.3.0", "unknown")).toBe(false);
    expect(isNewer(null, "0.2.9")).toBe(false);
  });
});

/* ---- the manual channel (self-hosted server) ----------------------------- */

function githubFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const RELEASE = {
  tag_name: "v0.3.0",
  body: "- Something new\n",
  html_url: "https://github.com/Remedy92/boxaide/releases/tag/v0.3.0",
  published_at: "2026-08-01T10:00:00Z",
};

describe("UpdateService, manual channel", () => {
  it("reports a newer release and can never install it", async () => {
    const service = new UpdateService({
      currentVersion: "0.2.9",
      fetchImpl: githubFetch(RELEASE),
    });
    await service.check();
    const state = service.state();
    expect(state.channel).toBe("manual");
    expect(state.status).toBe("available");
    expect(state.latestVersion).toBe("0.3.0");
    expect(state.notes).toBe("- Something new");
    expect(state.releaseUrl).toBe(RELEASE.html_url);
    expect(state.canInstall).toBe(false);
  });

  it("stays quiet when the release is the version already running", async () => {
    const service = new UpdateService({
      currentVersion: "0.3.0",
      fetchImpl: githubFetch(RELEASE),
    });
    await service.check();
    expect(service.state().status).toBe("up-to-date");
    expect(service.state().error).toBeNull();
  });

  it("survives an offline check without claiming anything", async () => {
    const service = new UpdateService({
      currentVersion: "0.2.9",
      fetchImpl: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      }) as unknown as typeof fetch,
    });
    await service.check();
    expect(service.state().status).toBe("error");
    expect(service.state().latestVersion).toBeNull();
    expect(service.state().error).toContain("ENOTFOUND");
  });

  it("keeps an update it already found when a later check fails", async () => {
    let fail = false;
    const service = new UpdateService({
      currentVersion: "0.2.9",
      fetchImpl: (async () => {
        if (fail) throw new Error("network down");
        return new Response(JSON.stringify(RELEASE), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await service.check();
    fail = true;
    await service.check();
    const state = service.state();
    expect(state.status).toBe("available");
    expect(state.latestVersion).toBe("0.3.0");
    expect(state.error).toBe("network down");
  });

  it("names rate limiting rather than reporting a bare 403", async () => {
    const service = new UpdateService({
      currentVersion: "0.2.9",
      fetchImpl: githubFetch({}, 403),
    });
    await service.check();
    expect(service.state().error).toMatch(/rate-limit/);
  });

  it("checks without throwing when there is nothing it can download", async () => {
    const service = new UpdateService({
      currentVersion: "0.2.9",
      fetchImpl: githubFetch(RELEASE),
    });
    await service.checkAndDownload();
    expect(service.state().status).toBe("available");
    expect(service.state().canInstall).toBe(false);
  });

  it("refuses to download or install", () => {
    const service = new UpdateService({ currentVersion: "0.2.9" });
    expect(() => service.download()).toThrow(/npm or git/);
    expect(() => service.install()).toThrow(/npm or git/);
  });
});

/* ---- the auto channel (desktop app) -------------------------------------- */

function fakeDriver(): {
  driver: UpdateDriver;
  emit: (event: DriverEvent) => void;
  downloads: number;
  installs: number;
} {
  let sink: (event: DriverEvent) => void = () => {};
  const counts = { downloads: 0, installs: 0 };
  const driver: UpdateDriver = {
    canInstall: true,
    subscribe: (emit) => {
      sink = emit;
    },
    check: async () => {},
    download: async () => {
      counts.downloads += 1;
    },
    install: () => {
      counts.installs += 1;
    },
  };
  return {
    driver,
    emit: (event) => sink(event),
    get downloads() {
      return counts.downloads;
    },
    get installs() {
      return counts.installs;
    },
  };
}

describe("UpdateService, auto channel", () => {
  it("walks available -> downloading -> ready", async () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });

    fake.emit({ kind: "available", version: "0.3.0", notes: "notes" });
    expect(service.state().status).toBe("available");
    expect(service.state().canInstall).toBe(true);
    // The release page is derived from the tag, not fetched a second time.
    expect(service.state().releaseUrl).toContain("/releases/tag/v0.3.0");

    service.download();
    expect(fake.downloads).toBe(1);
    fake.emit({ kind: "progress", percent: 42 });
    expect(service.state().status).toBe("downloading");
    expect(service.state().progress).toBeCloseTo(0.42);

    fake.emit({ kind: "downloaded", version: "0.3.0" });
    expect(service.state().status).toBe("ready");
    expect(service.state().progress).toBe(1);

    service.install();
    expect(fake.installs).toBe(1);
  });

  it("ignores an update-available for the version already running", () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.3.0",
      driver: fake.driver,
    });
    fake.emit({ kind: "available", version: "0.3.0" });
    expect(service.state().status).toBe("up-to-date");
    expect(service.state().canInstall).toBe(false);
  });

  it("does not restart a download that a re-check re-announces", () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.emit({ kind: "available", version: "0.3.0" });
    service.download();
    fake.emit({ kind: "downloaded", version: "0.3.0" });
    fake.emit({ kind: "available", version: "0.3.0" });
    expect(service.state().status).toBe("ready");
    service.download();
    expect(fake.downloads).toBe(1);
  });

  it("falls back to the offer when the download fails", () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.emit({ kind: "available", version: "0.3.0" });
    service.download();
    fake.emit({ kind: "error", message: "sha512 mismatch" });
    const state = service.state();
    expect(state.status).toBe("available");
    expect(state.error).toBe("sha512 mismatch");
    expect(state.progress).toBeNull();
  });

  it("starts the download the check found, for checkAndDownload", async () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    // electron-updater answers a check by emitting; the fake does it here.
    fake.driver.check = async () => {
      fake.emit({ kind: "available", version: "0.3.0" });
    };
    await service.checkAndDownload();
    expect(fake.downloads).toBe(1);
    expect(service.state().status).toBe("downloading");
  });

  it("does not download when checkAndDownload finds nothing", async () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.driver.check = async () => {
      fake.emit({ kind: "not-available", version: "0.2.9" });
    };
    await service.checkAndDownload();
    expect(fake.downloads).toBe(0);
    expect(service.state().status).toBe("up-to-date");
  });

  it("refuses to install before the download lands", () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.emit({ kind: "available", version: "0.3.0" });
    expect(() => service.install()).toThrow(/not downloaded/);
    expect(fake.installs).toBe(0);
  });
});

/* ---- a re-check must not take the offer off screen ----------------------- */

/**
 * The rail draws its card from `status` alone, and hides it for anything that
 * is not available/downloading/ready. So a check that runs while an update is
 * already on offer must leave the status where it is: the six-hour timer fires
 * unprompted, and the tray's "Check for updates…" runs one at the very moment
 * it opens the window to show the answer.
 */
describe("UpdateService, checking over a known update", () => {
  it("says checking when there is nothing on screen to keep", () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.emit({ kind: "checking" });
    expect(service.state().status).toBe("checking");
  });

  it("holds the offer through a driver re-check", async () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.emit({ kind: "available", version: "0.3.0" });

    const inFlight = service.check();
    // electron-updater announces the check it was just handed.
    fake.emit({ kind: "checking" });
    expect(service.state().status).toBe("available");
    await inFlight;
    expect(service.state().status).toBe("available");
    expect(service.state().latestVersion).toBe("0.3.0");
  });

  it("holds the offer through a manual re-check", async () => {
    /** Set to hold the second request open, so mid-flight can be observed. */
    let held: Promise<Response> | null = null;
    const service = new UpdateService({
      currentVersion: "0.2.9",
      fetchImpl: (() =>
        held ??
        Promise.resolve(
          new Response(JSON.stringify(RELEASE), { status: 200 }),
        )) as unknown as typeof fetch,
    });
    await service.check();
    expect(service.state().status).toBe("available");

    let land: (value: Response) => void = () => {};
    held = new Promise<Response>((resolve) => {
      land = resolve;
    });
    const inFlight = service.check();
    expect(service.state().status).toBe("available");
    land(new Response(JSON.stringify(RELEASE), { status: 200 }));
    await inFlight;
    expect(service.state().status).toBe("available");
  });

  it("still reports up-to-date when the re-check finds the offer withdrawn", async () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.emit({ kind: "available", version: "0.3.0" });
    await service.check();
    // Holding "available" through the check must not survive the answer.
    fake.emit({ kind: "not-available", version: "0.2.9" });
    expect(service.state().status).toBe("up-to-date");
  });
});

/* ---- the REST surface ---------------------------------------------------- */

function routed(service: UpdateService): Hono {
  const app = new Hono();
  registerUpdateRoutes(app, service);
  return app;
}

describe("update routes", () => {
  it("answers GET /api/update with the whole state", async () => {
    const service = new UpdateService({
      currentVersion: "0.2.9",
      fetchImpl: githubFetch(RELEASE),
    });
    const res = await routed(service).request("/api/update");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      channel: "manual",
      currentVersion: "0.2.9",
      status: "idle",
    });
  });

  it("returns the answer, not an ack, from POST /api/update/check", async () => {
    const service = new UpdateService({
      currentVersion: "0.2.9",
      fetchImpl: githubFetch(RELEASE),
    });
    const res = await routed(service).request("/api/update/check", { method: "POST" });
    expect(await res.json()).toMatchObject({
      status: "available",
      latestVersion: "0.3.0",
    });
  });

  it("checks and downloads from POST /api/update/check", async () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.driver.check = async () => {
      fake.emit({ kind: "available", version: "0.3.0" });
    };
    const res = await routed(service).request("/api/update/check", {
      method: "POST",
    });
    expect(await res.json()).toMatchObject({ status: "downloading" });
    expect(fake.downloads).toBe(1);
  });

  it("checks without downloading when asked not to", async () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.driver.check = async () => {
      fake.emit({ kind: "available", version: "0.3.0" });
    };
    const res = await routed(service).request("/api/update/check?download=0", {
      method: "POST",
    });
    expect(await res.json()).toMatchObject({ status: "available" });
    expect(fake.downloads).toBe(0);
  });

  it("refuses a download on the manual channel with 409", async () => {
    const service = new UpdateService({ currentVersion: "0.2.9" });
    const res = await routed(service).request("/api/update/download", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("refuses an install before the download lands with 409", async () => {
    const fake = fakeDriver();
    const service = new UpdateService({
      currentVersion: "0.2.9",
      driver: fake.driver,
    });
    fake.emit({ kind: "available", version: "0.3.0" });
    const res = await routed(service).request("/api/update/install", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(fake.installs).toBe(0);
  });

  it("replies before it quits, so the page never sees a dead request", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeDriver();
      const service = new UpdateService({
        currentVersion: "0.2.9",
        driver: fake.driver,
      });
      fake.emit({ kind: "available", version: "0.3.0" });
      fake.emit({ kind: "downloaded", version: "0.3.0" });
      const res = await routed(service).request("/api/update/install", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(fake.installs).toBe(0);
      vi.advanceTimersByTime(300);
      expect(fake.installs).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

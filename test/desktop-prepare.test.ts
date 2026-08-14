import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  electronBinaryReady,
  lockHash,
  lockStampPath,
  markNpmInstalled,
  markWebExport,
  needsNpmInstall,
  readStamp,
  sourceNeedsCopy,
  webExportStale,
  writeStamp,
} from "../scripts/lib/stale.mjs";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "mailmux-desktop-"));
  temps.push(dir);
  return dir;
}

function touch(path: string, when: Date, contents = "x") {
  writeFileSync(path, contents);
  utimesSync(path, when, when);
}

describe("needsNpmInstall", () => {
  it("is true when node_modules is missing", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(await needsNpmInstall(dir)).toBe(true);
  });

  it("is true when node_modules exists but has no install", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(dir, "node_modules", ".boxaide-lock"), "stale");
    expect(await needsNpmInstall(dir)).toBe(true);
  });

  it("is false when a real install exists and there is no stamp yet", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(await needsNpmInstall(dir)).toBe(false);
  });

  it("is false when the stamp matches the lockfile", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}");
    writeFileSync(join(dir, "package-lock.json"), '{ "lockfileVersion": 3 }');
    await markNpmInstalled(dir);
    expect(await needsNpmInstall(dir)).toBe(false);
  });

  it("is true when the lockfile no longer matches the stamp", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}");
    writeFileSync(join(dir, "package-lock.json"), "{ \"a\": 1 }");
    await markNpmInstalled(dir);
    writeFileSync(join(dir, "package-lock.json"), "{ \"a\": 2 }");
    expect(await needsNpmInstall(dir)).toBe(true);
  });

  it("markNpmInstalled writes a stamp equal to the lock hash", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "package-lock.json"), "{ \"ok\": true }");
    await markNpmInstalled(dir);
    expect(await readStamp(lockStampPath(dir))).toBe(await lockHash(dir));
  });
});

describe("sourceNeedsCopy", () => {
  it("is true when the dest is missing", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "from"));
    writeFileSync(join(dir, "from", "app.js"), "ok");
    expect(await sourceNeedsCopy(join(dir, "from"), join(dir, "to"))).toBe(true);
  });

  it("is false when dest is at least as new as source", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "from"));
    mkdirSync(join(dir, "to"));
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-01-02T00:00:00Z");
    touch(join(dir, "from", "app.js"), old);
    touch(join(dir, "to", "app.js"), recent);
    expect(await sourceNeedsCopy(join(dir, "from"), join(dir, "to"))).toBe(false);
  });

  it("is true when a source file is newer than dest", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "from"));
    mkdirSync(join(dir, "to"));
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-01-02T00:00:00Z");
    touch(join(dir, "to", "app.js"), old);
    touch(join(dir, "from", "app.js"), recent);
    expect(await sourceNeedsCopy(join(dir, "from"), join(dir, "to"))).toBe(true);
  });
});

describe("electronBinaryReady", () => {
  it("is false when path.txt is missing", async () => {
    expect(await electronBinaryReady(tempDir())).toBe(false);
  });

  it("is true when path.txt points at a real binary", async () => {
    const dir = tempDir();
    const dist = join(dir, "node_modules", "electron", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dir, "node_modules", "electron", "path.txt"), "Electron.app/Contents/MacOS/Electron");
    mkdirSync(join(dist, "Electron.app", "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(dist, "Electron.app", "Contents", "MacOS", "Electron"), "fake");
    expect(await electronBinaryReady(dir)).toBe(true);
  });
});

describe("webExportStale", () => {
  function webTree(dir: string) {
    mkdirSync(join(dir, "apps", "web", "src"), { recursive: true });
    mkdirSync(join(dir, "web-next"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "src", "page.tsx"), "export default function Page() {}");
    writeFileSync(join(dir, "apps", "web", "package-lock.json"), "{}");
    writeFileSync(join(dir, "web-next", "index.html"), "<html></html>");
  }

  it("is true when web-next is missing", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "apps", "web", "src"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "package-lock.json"), "{}");
    expect(await webExportStale(dir)).toBe(true);
  });

  it("is true when the export exists but was never stamped by web:sync", async () => {
    const dir = tempDir();
    webTree(dir);
    expect(await webExportStale(dir)).toBe(true);
  });

  it("is false when the stamp matches the web source", async () => {
    const dir = tempDir();
    webTree(dir);
    await markWebExport(dir);
    expect(await webExportStale(dir)).toBe(false);
  });

  it("is true when the web source no longer matches the stamp", async () => {
    const dir = tempDir();
    webTree(dir);
    await markWebExport(dir);
    writeFileSync(join(dir, "apps", "web", "src", "page.tsx"), "export default function Other() {}");
    expect(await webExportStale(dir)).toBe(true);
  });

  it("writeStamp is what markWebExport uses", async () => {
    const dir = tempDir();
    webTree(dir);
    await writeStamp(join(dir, "apps", "web", ".boxaide-export"), "not-the-hash");
    expect(await webExportStale(dir)).toBe(true);
  });
});

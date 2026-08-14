import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VERSION_FILES,
  applyVersion,
  bumpRoot,
  nextPatch,
  readVersion,
} from "../scripts/lib/bump-version.mjs";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("nextPatch", () => {
  it("increments the last number", () => {
    expect(nextPatch("0.2.1")).toBe("0.2.2");
  });

  it("rejects a non-patch version", () => {
    expect(() => nextPatch("1.0")).toThrow(/patchable/);
  });
});

describe("applyVersion", () => {
  it("moves the package version and leaves a 0.2.1 dependency alone", () => {
    const lock = `{
  "name": "boxaide-desktop",
  "version": "0.2.1",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "boxaide-desktop",
      "version": "0.2.1"
    },
    "node_modules/node-api-version": {
      "version": "0.2.1"
    }
  }
}
`;
    const { text, hits } = applyVersion(lock, "0.2.1", "0.2.2");
    expect(hits).toBe(2);
    expect(text).toContain('"version": "0.2.2"');
    expect(text).toMatch(/node_modules\/node-api-version": \{\n {6}"version": "0\.2\.1"/);
  });

  it("does not rewrite dependency 0.2.1 lines in the real desktop lockfile", () => {
    const current = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version;
    const bumped = nextPatch(current);
    const text = readFileSync("apps/desktop/package-lock.json", "utf8");
    const { text: next } = applyVersion(text, current, bumped);
    expect(next).toContain("node-api-version-0.2.1.tgz");
    expect(next).toMatch(/"node_modules\/node-api-version": \{\n {6}"version": "0\.2\.1"/);
    expect(next.startsWith(`{\n  "name": "boxaide-desktop",\n  "version": "${bumped}"`)).toBe(true);
  });

  it("rejects a file whose top-level version does not match", () => {
    expect(() => applyVersion(`{\n  "version": "9.9.9"\n}\n`, "0.2.1", "0.2.2")).toThrow(
      /not 0\.2\.1/,
    );
  });
});

describe("bumpRoot", () => {
  it("updates the same files the Cut commit touches", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailmux-bump-"));
    temps.push(dir);
    mkdirSync(join(dir, "apps/desktop"), { recursive: true });
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    mkdirSync(join(dir, "apps/mcpb"), { recursive: true });

    const pkg = `{
  "name": "x",
  "version": "0.2.1"
}
`;
    const lock = `{
  "name": "x",
  "version": "0.2.1",
  "packages": {
    "": {
      "version": "0.2.1"
    }
  }
}
`;
    writeFileSync(join(dir, "package.json"), pkg);
    writeFileSync(join(dir, "package-lock.json"), lock);
    writeFileSync(join(dir, "apps/desktop/package.json"), pkg);
    writeFileSync(join(dir, "apps/desktop/package-lock.json"), lock);
    writeFileSync(join(dir, "apps/web/package.json"), pkg);
    writeFileSync(join(dir, "apps/web/package-lock.json"), lock);
    writeFileSync(join(dir, "apps/mcpb/manifest.json"), pkg);

    expect(VERSION_FILES).toHaveLength(7);
    const result = bumpRoot(dir, "0.2.2");
    expect(result).toEqual({ from: "0.2.1", to: "0.2.2" });
    expect(readVersion(dir)).toBe("0.2.2");
    expect(readFileSync(join(dir, "apps/mcpb/manifest.json"), "utf8")).toContain(
      '"version": "0.2.2"',
    );
    expect(JSON.parse(readFileSync(join(dir, "apps/desktop/package-lock.json"), "utf8"))).toMatchObject({
      version: "0.2.2",
      packages: { "": { version: "0.2.2" } },
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_LENGTH,
  checkSubject,
  isExempt,
  report,
  stripPrNumber,
} from "../scripts/lib/check-subject.mjs";

describe("checkSubject", () => {
  it("passes a subject written for the person reading the release", () => {
    expect(checkSubject("Show release notes as plain words, not markup")).toEqual([]);
  });

  it("rejects an opener that describes the diff", () => {
    expect(checkSubject("Refactor the sweep handler").join()).toMatch(/not the app/);
    expect(checkSubject("Bump better-sqlite3").join()).toMatch(/not the app/);
    expect(checkSubject("Refactoring the docs").join()).toMatch(/not the app/);
    expect(checkSubject("WIP on the rail").join()).toMatch(/not the app/);
  });

  it("leaves alone the two openers that block good copy", () => {
    expect(checkSubject("Update the app in place, and say so in the rail")).toEqual([]);
    expect(checkSubject("Clean up four leftovers from the HTML mail reader")).toEqual([]);
  });

  it("rejects a commit-type prefix", () => {
    expect(checkSubject("feat: add sweep undo").join()).toMatch(/commit-type prefix/);
    expect(checkSubject("fix(updater)!: stop the crash").join()).toMatch(/commit-type prefix/);
  });

  it("rejects a subject past the ceiling", () => {
    const long = `A${"a".repeat(MAX_LENGTH)}`;
    expect(checkSubject(long).join()).toMatch(/ceiling/);
  });

  it("rejects a trailing full stop, a lowercase start, and an em dash", () => {
    expect(checkSubject("Archive mail.").join()).toMatch(/full stop/);
    expect(checkSubject("archive mail").join()).toMatch(/capital letter/);
    expect(checkSubject("Archive mail — and undo it").join()).toMatch(/em dash/);
  });

  it("judges the words, not the number a squash-merge appended", () => {
    expect(stripPrNumber("Archive mail (#84)")).toBe("Archive mail");
    expect(checkSubject("Archive mail (#84)")).toEqual([]);
    expect(checkSubject("Refactor the handler (#84)")).toHaveLength(1);
  });

  it("lets through the subjects that never become a release note", () => {
    for (const subject of [
      "Merge branch 'master' into fix",
      "Cut 0.2.26",
      'Revert "Refactor the sweep handler"',
      "fixup! refactor the handler",
    ]) {
      expect(isExempt(subject)).toBe(true);
      expect(checkSubject(subject)).toEqual([]);
    }
  });

  it("calls an empty subject empty and stops there", () => {
    expect(checkSubject("   ")).toEqual(["is empty"]);
  });
});

describe("report", () => {
  it("is empty when every subject passes", () => {
    expect(report(["Archive mail, and give an agent's sweep one undo"])).toBe("");
  });

  it("names the subject above each of its problems", () => {
    const text = report(["Archive mail.", "Refactor the handler"]);
    expect(text).toContain("  Archive mail.");
    expect(text).toContain("    - ends with a full stop");
    expect(text).toContain("  Refactor the handler");
  });
});

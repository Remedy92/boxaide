import { describe, expect, it } from "vitest";
import {
  SEEN_FRESH_MS,
  formatClock,
  stepsHeadline,
  workStale,
} from "../apps/web/src/components/agent/steps-copy.ts";

describe("formatClock", () => {
  it("uses seconds under a minute", () => {
    expect(formatClock(0)).toBe("0s");
    expect(formatClock(59)).toBe("59s");
  });

  it("zero-pads seconds past a minute", () => {
    expect(formatClock(60)).toBe("1m 00s");
    expect(formatClock(75)).toBe("1m 15s");
  });
});

describe("workStale", () => {
  const now = Date.parse("2026-01-01T00:01:00.000Z");

  it("is stale with no last-seen stamp", () => {
    expect(workStale(null, now)).toBe(true);
  });

  it("is fresh inside the presence window", () => {
    expect(workStale(new Date(now - SEEN_FRESH_MS + 1).toISOString(), now)).toBe(
      false,
    );
  });

  it("is stale at the window", () => {
    expect(workStale(new Date(now - SEEN_FRESH_MS).toISOString(), now)).toBe(
      true,
    );
  });
});

describe("stepsHeadline", () => {
  const now = Date.parse("2026-01-01T00:01:00.000Z");

  it("uses the live tool as the working headline", () => {
    expect(
      stepsHeadline({
        running: true,
        lastSeenAt: new Date(now).toISOString(),
        toolLabel: "Reading your inbox",
        stepCount: 3,
        took: null,
        now,
      }),
    ).toBe("Working — Reading your inbox");
  });

  it("says Working with no tool yet", () => {
    expect(
      stepsHeadline({
        running: true,
        lastSeenAt: new Date(now).toISOString(),
        toolLabel: null,
        stepCount: 0,
        took: null,
        now,
      }),
    ).toBe("Working");
  });

  it("keeps the claim and downgrades to no update when last-seen is stale", () => {
    expect(
      stepsHeadline({
        running: true,
        lastSeenAt: new Date(now - 45_000).toISOString(),
        toolLabel: "Reading your inbox",
        stepCount: 2,
        took: null,
        now,
      }),
    ).toBe("Working — no update for 45s");
  });

  it("does not invent a duration when last-seen is missing", () => {
    expect(
      stepsHeadline({
        running: true,
        lastSeenAt: null,
        toolLabel: "Reading your inbox",
        stepCount: 1,
        took: null,
        now,
      }),
    ).toBe("Working — no update yet");
  });

  it("folds to the activity count after the answer", () => {
    expect(
      stepsHeadline({
        running: false,
        lastSeenAt: null,
        toolLabel: null,
        stepCount: 3,
        took: 12,
        now,
      }),
    ).toBe("3 steps · 12s");
    expect(
      stepsHeadline({
        running: false,
        lastSeenAt: null,
        toolLabel: null,
        stepCount: 1,
        took: null,
        now,
      }),
    ).toBe("1 step");
  });
});

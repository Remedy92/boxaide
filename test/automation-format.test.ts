import { describe, expect, it } from "vitest";
import {
  describeCron,
  runStatusLabel,
} from "../apps/web/src/lib/format/automation.ts";

describe("describeCron", () => {
  it("describes the daily shape", () => {
    expect(describeCron("30 7 * * *")).toBe("Daily at 07:30");
  });

  it("describes a weekday, counting 0 and 7 as Sunday", () => {
    expect(describeCron("0 9 * * 1")).toBe("Weekly on Monday at 09:00");
    expect(describeCron("0 9 * * 0")).toBe("Weekly on Sunday at 09:00");
    expect(describeCron("0 9 * * 7")).toBe("Weekly on Sunday at 09:00");
  });

  it("describes a day of the month", () => {
    expect(describeCron("0 6 1 * *")).toBe("Monthly on day 1 at 06:00");
  });

  it("describes minute steps and the hourly shape", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("*/1 * * * *")).toBe("Every minute");
    expect(describeCron("5 * * * *")).toBe("Hourly, at :05");
  });

  /* The raw expression is always shown beside the sentence, so an unrecognised
     shape falls back to it rather than to a guess. */
  it("falls back to the expression it cannot describe", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("0 9 * * 1-5");
    expect(describeCron("0 0 1 1 *")).toBe("0 0 1 1 *");
  });

  /* Six fields is the seconds form, which the store rejects — nothing to
     describe, and describing it as a schedule would be a lie. */
  it("does not describe a field count the server refuses", () => {
    expect(describeCron("* * * * * *")).toBe("* * * * * *");
    expect(describeCron("30 7 * *")).toBe("30 7 * *");
  });
});

describe("runStatusLabel", () => {
  it("names the four run states", () => {
    expect(runStatusLabel("running")).toBe("Running");
    expect(runStatusLabel("ok")).toBe("Succeeded");
    expect(runStatusLabel("error")).toBe("Failed");
    expect(runStatusLabel("killed")).toBe("Timed out");
  });

  it("passes through anything a newer server sends", () => {
    expect(runStatusLabel("skipped")).toBe("skipped");
  });
});

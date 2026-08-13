import { describe, expect, it } from "vitest";
import { formatDealValue } from "../apps/web/src/lib/format/deal.ts";

describe("formatDealValue", () => {
  it("is empty when the deal carries no value", () => {
    expect(formatDealValue({ value: null, currency: "EUR" })).toBe("");
  });

  it("prints the amount alone when no currency was stored", () => {
    expect(formatDealValue({ value: 1200, currency: null })).toBe(
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(1200),
    );
  });

  /* The column is free TEXT — nothing validates it against ISO 4217 — so the
     string is appended rather than handed to Intl as a currency code, which
     would throw on anything that is not one. */
  it("appends whatever currency string was stored", () => {
    expect(formatDealValue({ value: 5, currency: "credits" })).toBe(
      "5 credits",
    );
  });

  it("keeps at most two fraction digits", () => {
    expect(formatDealValue({ value: 1.239, currency: "EUR" })).toBe(
      `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
        1.239,
      )} EUR`,
    );
  });
});

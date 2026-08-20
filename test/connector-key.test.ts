/**
 * Cleaning a pasted API key, and the catalogue the Connectors screen renders
 * around it.
 *
 * The assertion that matters most is the negative one: cleanPastedKey must not
 * know what a key looks like. A vendor changes a key format without telling
 * anybody, and a helpful regex would then refuse a real key and send somebody
 * back to that vendor for a replacement they did not need. Only packaging that
 * cannot be part of a key comes off.
 */
import { describe, it, expect } from "vitest";
import { cleanPastedKey } from "../apps/web/src/lib/connector-key.ts";
import { CATALOG, byRank, factsFor } from "../apps/web/src/lib/connector-catalog.ts";
import { CONNECTORS } from "../src/connectors/types.js";

describe("cleanPastedKey", () => {
  it("leaves a clean key exactly as it is", () => {
    const result = cleanPastedKey("abc123DEF456");
    expect(result).toEqual({ key: "abc123DEF456", removed: null, problem: null });
  });

  it("trims the newline a terminal copy brings with it", () => {
    expect(cleanPastedKey("  abc123\n").key).toBe("abc123");
    expect(cleanPastedKey("  abc123\n").removed).toBeNull();
  });

  it("takes the variable name off a pasted .env line", () => {
    const result = cleanPastedKey("BOXAIDE_EXA_API_KEY=abc123");
    expect(result.key).toBe("abc123");
    expect(result.removed).toBe("the variable name");
    expect(result.problem).toBeNull();
  });

  it("handles an exported, quoted env line in one go", () => {
    const result = cleanPastedKey('export HUNTER_API_KEY="abc123"');
    expect(result.key).toBe("abc123");
    expect(result.removed).toContain("the variable name");
    expect(result.removed).toContain("the quotes");
  });

  it("takes a Bearer header apart", () => {
    expect(cleanPastedKey("Authorization: Bearer abc123").key).toBe("abc123");
    expect(cleanPastedKey("bearer abc123").key).toBe("abc123");
    expect(cleanPastedKey("x-api-key: abc123").key).toBe("abc123");
  });

  it("unwraps a key copied out of JSON", () => {
    const result = cleanPastedKey('"abc123"');
    expect(result.key).toBe("abc123");
    expect(result.removed).toBe("the quotes");
  });

  /* The point of the narrow rules: a key is whatever the vendor issued. */
  it("keeps a trailing = that is part of a base64 key", () => {
    expect(cleanPastedKey("YWJjMTIz==").key).toBe("YWJjMTIz==");
    expect(cleanPastedKey("YWJjMTIz==").removed).toBeNull();
  });

  it("keeps an unfamiliar shape rather than guessing it is wrong", () => {
    for (const key of ["sk-proj-abc", "0f8a-11ee-b962", "prospeo_live_9", "x"]) {
      const result = cleanPastedKey(key);
      expect(result.key).toBe(key);
      expect(result.problem).toBeNull();
    }
  });

  it("leaves an unbalanced quote alone rather than eating a real character", () => {
    expect(cleanPastedKey('"abc123').key).toBe('"abc123');
  });

  it("refuses an empty paste", () => {
    expect(cleanPastedKey("   ").key).toBe("");
    expect(cleanPastedKey("   ").problem).toMatch(/no key/i);
  });

  it("refuses a paste that is still more than one value", () => {
    const result = cleanPastedKey("abc123 def456");
    expect(result.problem).toMatch(/space/i);
  });
});

describe("the connector catalogue", () => {
  it("covers every connector the server offers", () => {
    for (const def of CONNECTORS) {
      expect(factsFor(def.id), `no catalogue entry for ${def.id}`).toBeDefined();
    }
  });

  it("serves every logo from Boxaide itself, never from the vendor", () => {
    for (const facts of Object.values(CATALOG)) {
      expect(facts.logo).toMatch(/^\/connectors\//);
    }
  });

  it("recommends exactly one provider per capability", () => {
    const kinds = new Set(CONNECTORS.map((def) => def.kind));
    for (const kind of kinds) {
      const ids = CONNECTORS.filter((def) => def.kind === kind).map((def) => def.id);
      const firsts = ids.filter((id) => CATALOG[id]?.rank === 0);
      expect(firsts, `${kind} should have one rank 0`).toHaveLength(1);
    }
  });

  it("puts the recommended provider first, whatever order the server sent", () => {
    const search = [{ id: "exa" }, { id: "parallel" }];
    expect(byRank(search).map((row) => row.id)).toEqual(["parallel", "exa"]);
  });

  it("leaves a connector it has never heard of at the back, in server order", () => {
    const rows = [{ id: "brandnew" }, { id: "exa" }, { id: "parallel" }];
    expect(byRank(rows).map((row) => row.id)).toEqual(["parallel", "exa", "brandnew"]);
  });
});

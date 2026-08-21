import { describe, expect, it } from "vitest";
import { appHashOf } from "../apps/desktop/src/app-hash.js";

/**
 * The one string the desktop shell evaluates inside the main window comes from
 * a navigation the tray page made. Only an app route may go through.
 */
describe("appHashOf", () => {
  it("forwards a hash that names a page in the app", () => {
    expect(appHashOf("http://127.0.0.1:4000/#/a/acc/m/acc%3AINBOX%3A1")).toBe(
      "#/a/acc/m/acc%3AINBOX%3A1",
    );
    expect(appHashOf("http://127.0.0.1:4000/#/settings/updates")).toBe(
      "#/settings/updates",
    );
    // The root: what "Open Boxaide" asks for, and it closes whatever is open.
    expect(appHashOf("http://127.0.0.1:4000/#/")).toBe("#/");
  });

  it("keeps every other fragment out of the window", () => {
    expect(appHashOf("http://127.0.0.1:4000/")).toBe("");
    expect(appHashOf("http://127.0.0.1:4000/#")).toBe("");
    expect(appHashOf("http://127.0.0.1:4000/#bootstrap=abc")).toBe("");
    expect(appHashOf("http://127.0.0.1:4000/#settings")).toBe("");
    expect(appHashOf("not a url")).toBe("");
  });

  it("spells a message the way the tray page and the app both do", () => {
    // tray/page.tsx writes the hash out by hand; this is the format it must
    // match, pinned here so a drift in either place fails a test.
    const accountId = "8d95800b2394f9f6";
    const messageId = "8d95800b2394f9f6:INBOX:1";
    const hash = `#/a/${encodeURIComponent(accountId)}/m/${encodeURIComponent(messageId)}`;
    expect(appHashOf(`http://127.0.0.1:4000/${hash}`)).toBe(hash);
    expect(/^#\/a\/[^/]+\/m\/[^/]+$/.test(hash)).toBe(true);
  });
});

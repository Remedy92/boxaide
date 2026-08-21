/**
 * The outreach chain is written once and read in four places, and one of them
 * cannot import it: apps/web is a separate build that never reaches into src/.
 * So the paragraph is hand-copied into the Connect-your-agent dialog, and the
 * only thing that ever held the two together was a comment. This is that
 * comment made into a gate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTREACH_CHAIN, OUTREACH_CHAIN_ONE_LINE } from "../src/agent/guidance.js";
import { DRIVEN_SYSTEM } from "../src/agent/driver.js";
import { AUTOMATION_RUN_PREAMBLE, KICKOFF } from "../src/agent/launcher.js";

const DIALOG = join(
  process.cwd(),
  "apps/web/src/components/dialogs/agent-connect-dialog.tsx",
);

describe("the outreach chain", () => {
  it("is in every prompt built from it", () => {
    expect(DRIVEN_SYSTEM).toContain(OUTREACH_CHAIN);
    expect(KICKOFF).toContain(OUTREACH_CHAIN);
    expect(AUTOMATION_RUN_PREAMBLE).toContain(OUTREACH_CHAIN_ONE_LINE);
  });

  it("is copied verbatim into the Connect-your-agent dialog", () => {
    expect(readFileSync(DIALOG, "utf8")).toContain(OUTREACH_CHAIN);
  });

  it("orders the address before the contact write, and names reveal", () => {
    const contactAt = OUTREACH_CHAIN.indexOf("crm_contact_upsert");
    const addressAt = OUTREACH_CHAIN.indexOf("reveal true");
    expect(addressAt).toBeGreaterThan(-1);
    expect(contactAt).toBeGreaterThan(addressAt);
    expect(OUTREACH_CHAIN).toContain("crm_outreach_state");
  });
});

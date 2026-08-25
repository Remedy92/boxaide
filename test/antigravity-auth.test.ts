import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAgyAuthFailure,
  isAgyAuthPrompt,
} from "../src/agent/agent-stream.js";
import {
  probeAntigravityAuth,
} from "../src/agent/clis/antigravity.js";
import {
  egressRefusedNote,
  isPlaywrightBootstrapHost,
} from "../src/agent/launcher.js";
import {
  antigravityLoginScript,
  watchForAntigravitySignIn,
} from "../src/api/routes.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function fakeAgy(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "boxaide-agy-auth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "agy");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

async function until(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Antigravity authentication", () => {
  it("accepts a model listing that finishes inside the readiness window", async () => {
    const bin = fakeAgy('/bin/sleep 0.05\necho "model-id\\tModel"');
    await expect(probeAntigravityAuth(bin, {}, 3_000)).resolves.toEqual({ ok: true });
  });

  it("distinguishes sign-in from a generic readiness timeout", async () => {
    const signedOut = fakeAgy(
      'echo "Waiting for authentication (timeout 60s)" >&2\nexit 1',
    );
    await expect(probeAntigravityAuth(signedOut, {}, 3_000)).resolves.toEqual({
      ok: false,
      authRequired: true,
      reason: "Antigravity needs sign-in",
    });

    const stalled = fakeAgy("exec /bin/sleep 1");
    await expect(probeAntigravityAuth(stalled, {}, 20)).resolves.toEqual({
      ok: false,
      authRequired: false,
      reason: "Antigravity readiness check timed out",
    });
  });

  it("keeps prompt detection narrow while recognizing completed auth failures", () => {
    expect(isAgyAuthPrompt("Waiting for authentication...")).toBe(true);
    expect(isAgyAuthPrompt("The API returned unauthenticated")).toBe(false);
    expect(isAgyAuthFailure("The API returned unauthenticated")).toBe(true);
  });

  it("polls actual readiness and restarts with the previous model", async () => {
    let probes = 0;
    const starts: Array<[string, string | undefined]> = [];
    const cancel = watchForAntigravitySignIn(
      {
        chatBusy: () => false,
        lastModelFor: () => "gemini-3.7-flash-medium",
        start: async (id, model) => {
          starts.push([id, model]);
        },
      },
      "/fake/agy",
      {
        pollMs: 5,
        windowMs: 500,
        verifier: async () => ++probes >= 2,
      },
    );
    cleanups.push(cancel);

    await until(() => starts.length === 1);
    expect(starts).toEqual([
      ["antigravity", "gemini-3.7-flash-medium"],
    ]);
  });

  it("quotes the Antigravity command for Terminal", () => {
    const script = antigravityLoginScript("/Users/Ada Byron/bin/agy");
    expect(script).toContain("'/Users/Ada Byron/bin/agy'");
    expect(script).toContain('tell application "Terminal"');
  });
});

describe("Antigravity Playwright bootstrap logging", () => {
  it("clarifies only hosts that actually name Playwright", () => {
    expect(isPlaywrightBootstrapHost("playwright.azureedge.net:443")).toBe(true);
    expect(isPlaywrightBootstrapHost("unrelated.azureedge.net:443")).toBe(false);
    expect(egressRefusedNote(["playwright.azureedge.net:443"])).toContain(
      "upstream Antigravity browser-bootstrap attempt",
    );
  });
});

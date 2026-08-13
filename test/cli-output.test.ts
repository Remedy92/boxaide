import { describe, it, expect, afterEach } from "vitest";
import { tokenLine } from "../src/cli-output.js";

const TOKEN = "test-token-abcdefghijklmnop";
const DIR = "/tmp/mailmux-test";
const realTTY = process.stdout.isTTY;

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  setTTY(realTTY);
  delete process.env.SLEY_TOKEN;
  delete process.env.MAILMUX_TOKEN;
});

describe("tokenLine", () => {
  it("prints the token to a terminal, where a human is reading it", () => {
    setTTY(true);
    expect(tokenLine(TOKEN, DIR)).toBe(`bearer token: ${TOKEN}`);
  });

  it("prints the file path when stdout is captured", () => {
    // A service manager or log collector keeps what it captures, and the
    // token grants full access to the mailboxes.
    setTTY(false);
    const line = tokenLine(TOKEN, DIR);
    expect(line).not.toContain(TOKEN);
    expect(line).toBe(`bearer token: ${DIR}/bearer.token (not printed)`);
  });

  it("names the env var instead of a path when the token came from one", () => {
    setTTY(false);
    process.env.SLEY_TOKEN = TOKEN;
    const line = tokenLine(TOKEN, DIR);
    expect(line).not.toContain(TOKEN);
    expect(line).toBe("bearer token: set via SLEY_TOKEN (not printed)");
  });

  it("falls back to MAILMUX_TOKEN when SLEY_TOKEN is unset", () => {
    setTTY(false);
    process.env.MAILMUX_TOKEN = TOKEN;
    const line = tokenLine(TOKEN, DIR);
    expect(line).toBe("bearer token: set via MAILMUX_TOKEN (not printed)");
  });

  it("treats an undefined isTTY as captured", () => {
    // Node leaves isTTY undefined on a pipe rather than setting it false.
    setTTY(undefined);
    expect(tokenLine(TOKEN, DIR)).not.toContain(TOKEN);
  });
});

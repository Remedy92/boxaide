import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentTargets,
  genericMcpSnippet,
} from "../apps/web/src/lib/agent-config.ts";
import { PROVIDER_PRESETS } from "../apps/web/src/lib/constants.ts";
import { friendlyError } from "../apps/web/src/lib/api/errors.ts";
import {
  LEGACY_TOKEN_KEY,
  SETTINGS_EVENT,
  SETTINGS_KEYS,
  adoptLegacyTheme,
  readSettings,
  writeSettings,
} from "../apps/web/src/lib/settings.ts";

const WEB_SRC = join(process.cwd(), "apps", "web", "src");

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

describe("web identity", () => {
  it("writes only boxaide.* settings keys", () => {
    expect(SETTINGS_KEYS).toEqual({
      baseUrl: "boxaide.baseUrl",
      token: "boxaide.token",
      density: "boxaide.density",
      railCollapsed: "boxaide.railCollapsed",
      recentCommands: "boxaide.recentCommands",
      onboarded: "boxaide.onboarded",
      agentModel: "boxaide.agentModel",
      theme: "boxaide.theme",
    });
    expect(SETTINGS_EVENT).toBe("boxaide:settings");
    expect(LEGACY_TOKEN_KEY).toBe("mailmux_token");
  });

  it("names the provider-step app password Boxaide", () => {
    const steps = PROVIDER_PRESETS.flatMap((preset) => preset.steps).join("\n");
    expect(steps).toMatch(/Boxaide/);
    expect(steps).not.toMatch(/mailmux/i);
  });

  it("builds MCP snippets under mcpServers.boxaide and /boxaide.mcpb", () => {
    const targets = buildAgentTargets({
      baseUrl: "http://127.0.0.1:8787",
      token: "tok",
    });
    const desktop = targets.find((entry) => entry.id === "claude-desktop");
    const cursor = targets.find((entry) => entry.id === "cursor");
    const antigravity = targets.find((entry) => entry.id === "antigravity");
    const opencode = targets.find((entry) => entry.id === "opencode");
    const cli = targets.find((entry) => entry.id === "cli");
    expect(desktop?.download).toEqual({
      href: "http://127.0.0.1:8787/boxaide.mcpb",
      filename: "boxaide.mcpb",
      action: "Download for Claude Desktop",
    });
    expect(desktop?.snippet).toContain('"boxaide"');
    expect(desktop?.snippet).toContain('"command": "boxaide"');
    expect(cursor?.snippet).toContain('"boxaide"');
    expect(antigravity?.snippet).toContain('"serverUrl": "http://127.0.0.1:8787/mcp"');
    expect(antigravity?.snippet).toContain('"Authorization": "Bearer tok"');
    expect(opencode?.snippet).toContain("opencode mcp add boxaide");
    expect(cli?.snippet).toBe("boxaide mcp");
    expect(genericMcpSnippet({ baseUrl: "http://127.0.0.1:8787", token: "tok" })).toContain(
      '"boxaide"',
    );
    expect(targets.map((entry) => entry.snippet).join("\n")).not.toMatch(/mailmux/i);
  });

  it("tells a refused origin to set BOXAIDE_ALLOWED_ORIGINS", () => {
    expect(friendlyError("forbidden origin")).toContain("BOXAIDE_ALLOWED_ORIGINS");
    expect(friendlyError("forbidden origin")).not.toMatch(/MAILMUX|mailmux/);
  });

  it("types HealthResponse.service as boxaide", () => {
    const types = readFileSync(join(WEB_SRC, "lib", "types.ts"), "utf8");
    expect(types).toContain('service: "boxaide"');
    expect(types).not.toContain('service: "mailmux"');
  });
});

describe("settings fallback", () => {
  const store = new MemoryStorage();

  afterEach(() => {
    store.clear();
    // @ts-expect-error test-only window
    delete globalThis.window;
  });

  function installWindow() {
    const win = {
      localStorage: store,
      dispatchEvent() {
        return true;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: win,
    });
  }

  it("reads sley.* when boxaide.* is absent", () => {
    installWindow();
    store.setItem("sley.token", "sley-token");
    store.setItem("sley.density", "compact");
    const settings = readSettings();
    expect(settings.token).toBe("sley-token");
    expect(settings.density).toBe("compact");
  });

  it("prefers boxaide.* over sley.* over mailmux.*", () => {
    installWindow();
    store.setItem("boxaide.token", "new-token");
    store.setItem("sley.token", "mid-token");
    store.setItem("mailmux.token", "old-token");
    expect(readSettings().token).toBe("new-token");
  });

  it("reads mailmux.* and mailmux_token when boxaide.* is absent", () => {
    installWindow();
    store.setItem("mailmux.baseUrl", "http://127.0.0.1:9999");
    store.setItem("mailmux_token", "legacy-token");
    store.setItem("mailmux.density", "compact");
    const settings = readSettings();
    expect(settings.baseUrl).toBe("http://127.0.0.1:9999");
    expect(settings.token).toBe("legacy-token");
    expect(settings.density).toBe("compact");
    expect(settings.onboarded).toBe(true);
  });

  it("prefers boxaide.* over mailmux.*", () => {
    installWindow();
    store.setItem("boxaide.token", "new-token");
    store.setItem("mailmux.token", "old-token");
    store.setItem("mailmux_token", "older-token");
    expect(readSettings().token).toBe("new-token");
  });

  it("writes only boxaide.* keys", () => {
    installWindow();
    writeSettings({ token: "fresh", onboarded: true });
    expect(store.getItem("boxaide.token")).toBe("fresh");
    expect(store.getItem("boxaide.onboarded")).toBe("1");
    expect(store.getItem("mailmux.token")).toBeNull();
    expect(store.getItem("mailmux_token")).toBeNull();
  });

  it("copies mailmux.theme onto boxaide.theme once", () => {
    installWindow();
    store.setItem("mailmux.theme", "dark");
    adoptLegacyTheme();
    expect(store.getItem("boxaide.theme")).toBe("dark");
    store.setItem("mailmux.theme", "light");
    adoptLegacyTheme();
    expect(store.getItem("boxaide.theme")).toBe("dark");
  });
});

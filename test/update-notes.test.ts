import { describe, expect, it } from "vitest";
import { readableNotes } from "../src/update/notes.js";
import { UpdateService, type DriverEvent, type UpdateDriver } from "../src/update/service.js";

/** The body electron-updater hands over: GitHub's feed, already rendered. */
const FEED_HTML = `<h2>What is new</h2>
<ul>
<li>Stop a node_modules symlink from reaching the repository again (<a class="issue-link js-issue-link" data-error-text="Failed to load title" data-id="5203434974" data-permission-text="Title is private" data-url="https://github.com/Remedy92/boxaide/issues/89" data-hovercard-type="pull_request" data-hovercard-url="/Remedy92/boxaide/pull/89/hovercard" href="https://github.com/Remedy92/boxaide/pull/89">#89</a>)</li>
<li>Archive mail, and give an agent&#39;s sweep one undo (<a href="https://github.com/Remedy92/boxaide/pull/88">#88</a>)</li>
</ul>`;

describe("readableNotes", () => {
  it("flattens the rendered feed body into plain lines", () => {
    expect(readableNotes(FEED_HTML)).toBe(
      [
        "- Stop a node_modules symlink from reaching the repository again",
        "- Archive mail, and give an agent's sweep one undo",
      ].join("\n"),
    );
  });

  it("leaves no tag or entity behind", () => {
    const out = readableNotes(FEED_HTML) ?? "";
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toMatch(/&[a-z#]/i);
    expect(out).not.toMatch(/data-|href=|issue-link/);
  });

  it("reads the markdown body the manual channel gets", () => {
    const raw = "## What is new\n\n- Give agents safe web research (#84)\n- Cut the picker's box\n";
    expect(readableNotes(raw)).toBe(
      "- Give agents safe web research\n- Cut the picker's box",
    );
  });

  it("drops the heading the app already draws, in either spelling", () => {
    for (const heading of ["## What is new", "# What's new", "Whats new?"]) {
      expect(readableNotes(`${heading}\n\n- One change`)).toBe("- One change");
    }
  });

  it("keeps prose that only looks like a tag", () => {
    expect(readableNotes("- Reject a From: <name> with no address")).toBe(
      "- Reject a From: <name> with no address",
    );
  });

  it("collapses runs of blank lines and trims the ends", () => {
    expect(readableNotes("\n\n- One\n\n\n\n- Two\n\n")).toBe("- One\n\n- Two");
  });

  it("drops a bare pull request link and its trailing space", () => {
    expect(
      readableNotes("- Fix the thing https://github.com/Remedy92/boxaide/pull/12"),
    ).toBe("- Fix the thing");
  });

  it("drops a body that ends mid-tag rather than printing half of it", () => {
    expect(readableNotes("<p>Real line</p><script")).toBe("Real line");
    expect(readableNotes("<p>Real line</p><b>bold</b><img src=x onerror")).toBe(
      "Real line\nbold",
    );
    expect(readableNotes("<p>Kept</p>&lt;name&gt;")).toBe("Kept\n<name>");
  });

  it("cannot be made to rebuild a tag out of overlapping ones", () => {
    const out = readableNotes("<p><scr<x>ipt>alert(1)</scr<x>ipt></p>") ?? "";
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/[<>]/);
  });

  it("answers null for nothing, and for markup that says nothing", () => {
    expect(readableNotes(null)).toBeNull();
    expect(readableNotes("")).toBeNull();
    expect(readableNotes("   \n\n ")).toBeNull();
    expect(readableNotes("<p></p>")).toBeNull();
  });

  it("normalises markdown bullets, links and emphasis", () => {
    expect(readableNotes("* See [the release](https://example.com) for **more**")).toBe(
      "- See the release for more",
    );
  });
});

describe("UpdateService notes", () => {
  function driverWith(notes: string) {
    let emit: (event: DriverEvent) => void = () => {};
    const driver: UpdateDriver = {
      canInstall: true,
      check: async () => {
        emit({ kind: "available", version: "9.9.9", notes });
      },
      download: async () => {},
      install: () => {},
      subscribe: (sink) => {
        emit = sink;
      },
    };
    return driver;
  }

  it("stores the flattened text, never the markup", async () => {
    const service = new UpdateService({
      currentVersion: "0.2.24",
      driver: driverWith(FEED_HTML),
    });
    await service.check();
    const notes = service.state().notes ?? "";
    expect(notes).not.toMatch(/[<>]/);
    expect(notes.startsWith("- Stop a node_modules symlink")).toBe(true);
  });
});

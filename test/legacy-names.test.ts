/**
 * The one-time move off `~/.sley` and `~/.mailmux`.
 *
 * The interesting cases are not the happy path — they are the ones where
 * migrating would cost somebody their mail: a target that already exists, an
 * agent subtree that would be left behind, a WAL file separated from the
 * database that committed into it. Each of those must end with the install
 * still working on the name it had.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateLegacyDataDir,
  migrateLegacyDatabase,
} from "../src/legacy-names.js";

/** A stand-in home directory, so nothing here touches a real install. */
function home(): string {
  return mkdtempSync(join(tmpdir(), "boxaide-home-"));
}

/** A directory with one recognisable file in it. */
function install(path: string, marker: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "bearer.token"), marker);
}

function marker(path: string): string {
  return readFileSync(join(path, "bearer.token"), "utf8");
}

describe("migrating a legacy data directory", () => {
  it("answers ~/.boxaide on a first run, and moves nothing", () => {
    const dir = home();
    expect(migrateLegacyDataDir(dir)).toBe(join(dir, ".boxaide"));
    // Answering the path is not creating it. That is loadConfig's job.
    expect(existsSync(join(dir, ".boxaide"))).toBe(false);
  });

  it("moves a ~/.sley install onto the current name", () => {
    const dir = home();
    install(join(dir, ".sley"), "sley-token");

    expect(migrateLegacyDataDir(dir)).toBe(join(dir, ".boxaide"));
    expect(marker(join(dir, ".boxaide"))).toBe("sley-token");
    expect(existsSync(join(dir, ".sley"))).toBe(false);
  });

  it("moves a ~/.mailmux install too", () => {
    const dir = home();
    install(join(dir, ".mailmux"), "mailmux-token");

    expect(migrateLegacyDataDir(dir)).toBe(join(dir, ".boxaide"));
    expect(marker(join(dir, ".boxaide"))).toBe("mailmux-token");
  });

  it("takes the agent subtree with it", () => {
    const dir = home();
    install(join(dir, ".sley"), "sley-token");
    // The notes live in the sibling, and the sibling's name is derived from
    // the data directory's. Left behind, they are gone.
    const notes = join(dir, ".sley-agents", "workdir", "memory");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "MEMORY.md"), "# notes");

    migrateLegacyDataDir(dir);

    expect(
      readFileSync(
        join(dir, ".boxaide-agents", "workdir", "memory", "MEMORY.md"),
        "utf8",
      ),
    ).toBe("# notes");
    expect(existsSync(join(dir, ".sley-agents"))).toBe(false);
  });

  it("is a no-op once it has run", () => {
    const dir = home();
    install(join(dir, ".sley"), "sley-token");

    expect(migrateLegacyDataDir(dir)).toBe(join(dir, ".boxaide"));
    expect(migrateLegacyDataDir(dir)).toBe(join(dir, ".boxaide"));
    expect(marker(join(dir, ".boxaide"))).toBe("sley-token");
  });

  it("never overwrites an install already on the current name", () => {
    const dir = home();
    install(join(dir, ".boxaide"), "current");
    install(join(dir, ".sley"), "legacy");

    expect(migrateLegacyDataDir(dir)).toBe(join(dir, ".boxaide"));
    // Both survive, untouched. Merging them would delete one install's mail.
    expect(marker(join(dir, ".boxaide"))).toBe("current");
    expect(marker(join(dir, ".sley"))).toBe("legacy");
  });

  it("prefers ~/.sley over ~/.mailmux, and leaves the older one alone", () => {
    const dir = home();
    install(join(dir, ".sley"), "sley-token");
    install(join(dir, ".mailmux"), "mailmux-token");

    expect(migrateLegacyDataDir(dir)).toBe(join(dir, ".boxaide"));
    expect(marker(join(dir, ".boxaide"))).toBe("sley-token");
    expect(marker(join(dir, ".mailmux"))).toBe("mailmux-token");
  });

  it("declines rather than half-migrate when both agent subtrees exist", () => {
    const dir = home();
    install(join(dir, ".sley"), "legacy");
    install(join(dir, ".sley-agents"), "legacy-agents");
    install(join(dir, ".boxaide-agents"), "current-agents");

    // A data directory moved onto a subtree that is not its own would hand
    // the agent another install's notes. Staying put is the safe answer.
    expect(migrateLegacyDataDir(dir)).toBe(join(dir, ".sley"));
    expect(marker(join(dir, ".sley"))).toBe("legacy");
    expect(marker(join(dir, ".sley-agents"))).toBe("legacy-agents");
    expect(marker(join(dir, ".boxaide-agents"))).toBe("current-agents");
  });
});

describe("migrating a legacy database", () => {
  it("answers boxaide.db when the directory is empty", () => {
    const dir = home();
    expect(migrateLegacyDatabase(dir)).toBe(join(dir, "boxaide.db"));
  });

  it("renames sley.db onto the current name", () => {
    const dir = home();
    writeFileSync(join(dir, "sley.db"), "rows");

    expect(migrateLegacyDatabase(dir)).toBe(join(dir, "boxaide.db"));
    expect(readFileSync(join(dir, "boxaide.db"), "utf8")).toBe("rows");
    expect(existsSync(join(dir, "sley.db"))).toBe(false);
  });

  it("renames mailmux.db too", () => {
    const dir = home();
    writeFileSync(join(dir, "mailmux.db"), "rows");

    expect(migrateLegacyDatabase(dir)).toBe(join(dir, "boxaide.db"));
    expect(readFileSync(join(dir, "boxaide.db"), "utf8")).toBe("rows");
  });

  it("carries the WAL sidecars across", () => {
    const dir = home();
    writeFileSync(join(dir, "sley.db"), "rows");
    // -wal holds transactions the database file does not. A rename that left
    // it behind would lose everything committed since the last checkpoint.
    writeFileSync(join(dir, "sley.db-wal"), "committed");
    writeFileSync(join(dir, "sley.db-shm"), "index");

    expect(migrateLegacyDatabase(dir)).toBe(join(dir, "boxaide.db"));
    expect(readFileSync(join(dir, "boxaide.db-wal"), "utf8")).toBe("committed");
    expect(readFileSync(join(dir, "boxaide.db-shm"), "utf8")).toBe("index");
    expect(existsSync(join(dir, "sley.db-wal"))).toBe(false);
  });

  it("leaves an existing boxaide.db alone", () => {
    const dir = home();
    writeFileSync(join(dir, "boxaide.db"), "current");
    writeFileSync(join(dir, "sley.db"), "legacy");

    expect(migrateLegacyDatabase(dir)).toBe(join(dir, "boxaide.db"));
    expect(readFileSync(join(dir, "boxaide.db"), "utf8")).toBe("current");
    expect(readFileSync(join(dir, "sley.db"), "utf8")).toBe("legacy");
  });

  it("is a no-op once it has run", () => {
    const dir = home();
    writeFileSync(join(dir, "sley.db"), "rows");

    expect(migrateLegacyDatabase(dir)).toBe(join(dir, "boxaide.db"));
    expect(migrateLegacyDatabase(dir)).toBe(join(dir, "boxaide.db"));
    expect(readFileSync(join(dir, "boxaide.db"), "utf8")).toBe("rows");
  });
});

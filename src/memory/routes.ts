/**
 * Workspace-memory REST routes, mounted inside createApi after auth.
 *
 * This is the one place the server writes memory content: a human editing the
 * agent's notes from Settings. Agents never go through here — they read and
 * write their own files with their native file tools, which is why the files
 * are plaintext (see src/memory/store.ts). The name in the path reaches a
 * filesystem path, so it is validated before any join; the size ceiling is
 * enforced by the store, and the request body itself is already bounded by
 * the server-wide body limit (MAX_HTTP_BODY_BYTES in src/app.ts).
 *
 *   GET  /api/memory              every file, index first, each with whether
 *                                 the bytes it holds now have been reviewed
 *   GET  /api/memory/:name        one file's text
 *   PUT  /api/memory/:name        { content } replaces one file
 *   POST /api/memory/:name/review the note as it stands reads right
 *
 * Review is the half of this surface that is not convenience. Automation runs
 * read only notes a person has seen (src/memory/reviews.ts), so these two
 * writes are how anything the agent learned unattended ever reaches one.
 * Saving an edit reviews it: a person who retyped a line has read it.
 */
import type { Hono } from "hono";
import type { Platform } from "../platform.js";
import { isReviewed, markReviewed } from "./reviews.js";
import { listMemoryFiles, readMemoryFile, writeMemoryFile } from "./store.js";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readJson<T>(c: {
  req: { json: () => Promise<unknown> };
}): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

export function registerMemoryRoutes(app: Hono, platform: Platform): void {
  // Absent on the graphs that build a platform without an install location —
  // the stdio MCP process and tool-only tests. Same answer the archive routes
  // give there: a 404 the UI reads as "this server has no such feature".
  const dataDir = platform.dataDir;

  app.get("/api/memory", async (c) => {
    if (!dataDir) return c.json({ error: "not available" }, 404);
    const files = await listMemoryFiles(dataDir);
    // Read per file rather than trusting size or mtime: the predicate is the
    // exact bytes, because that is what an automation run will be handed.
    const withReview = await Promise.all(
      files.map(async (file) => {
        const content = await readMemoryFile(dataDir, file.name);
        return {
          ...file,
          reviewed: content !== null && isReviewed(dataDir, file.name, content),
        };
      }),
    );
    return c.json({ files: withReview });
  });

  app.get("/api/memory/:name", async (c) => {
    if (!dataDir) return c.json({ error: "not available" }, 404);
    const name = c.req.param("name") ?? "";
    try {
      const content = await readMemoryFile(dataDir, name);
      if (content === null) return c.json({ error: "not found" }, 404);
      return c.json({ name, content });
    } catch (err) {
      // A name that fails validation is a bad request, not a missing file.
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  app.put("/api/memory/:name", async (c) => {
    if (!dataDir) return c.json({ error: "not available" }, 404);
    const body = await readJson<{ content?: unknown }>(c);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (typeof body.content !== "string") {
      return c.json({ error: "content is required and must be a string" }, 400);
    }
    const name = c.req.param("name") ?? "";
    try {
      await writeMemoryFile(dataDir, name, body.content);
      // The person typed it, so they have read it.
      markReviewed(dataDir, name, body.content);
      return c.json({ ok: true, reviewed: true });
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  /**
   * "This reads right." The note is left exactly as the agent wrote it and
   * becomes available to automation runs. Hashed at this moment, so a later
   * rewrite by the agent un-reviews it without anybody having to notice.
   */
  app.post("/api/memory/:name/review", async (c) => {
    if (!dataDir) return c.json({ error: "not available" }, 404);
    const name = c.req.param("name") ?? "";
    let content: string | null;
    try {
      content = await readMemoryFile(dataDir, name);
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
    if (content === null) return c.json({ error: "not found" }, 404);
    markReviewed(dataDir, name, content);
    return c.json({ ok: true, reviewed: true });
  });
}

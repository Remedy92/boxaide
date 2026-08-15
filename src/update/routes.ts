/**
 * Update REST routes, mounted inside createApi after auth.
 *
 * Every route answers with the whole state rather than an ack, so the sidebar
 * never has to guess what a command did — one shape, one source, no client
 * state machine to drift from the server's.
 */
import type { Hono } from "hono";
import { UpdateUnavailable, type UpdateService } from "./service.js";

export function registerUpdateRoutes(app: Hono, update: UpdateService): void {
  app.get("/api/update", (c) => c.json(update.state()));

  /** The "Check now" button. Waits for the answer so the reply is the answer. */
  app.post("/api/update/check", async (c) => {
    await update.check().catch(() => {});
    return c.json(update.state());
  });

  /**
   * Starts the download and replies immediately. Awaiting it would hold the
   * request open for the length of a 100 MB transfer; progress arrives through
   * polling GET /api/update instead.
   */
  app.post("/api/update/download", (c) => {
    try {
      update.download();
    } catch (err) {
      if (err instanceof UpdateUnavailable) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
    return c.json(update.state());
  });

  /**
   * Quits and relaunches into the new version. The reply is sent first: the
   * app is about to go away, and a fetch that never resolves looks like a
   * failure to the page that asked for it.
   */
  app.post("/api/update/install", (c) => {
    if (!update.state().canInstall || update.state().status !== "ready") {
      return c.json({ error: "The update is not downloaded yet." }, 409);
    }
    setTimeout(() => {
      try {
        update.install();
      } catch {
        // Nothing to report to: the response has already gone.
      }
    }, 250);
    return c.json(update.state());
  });
}

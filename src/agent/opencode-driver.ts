/**
 * Driving OpenCode from inside Boxaide, instead of asking it to drive itself.
 *
 * Every other launched CLI runs the chat loop because KICKOFF tells the model
 * to keep calling `chat_await_message`. That loop is a prompt instruction: the
 * model can decide it is finished, an MCP poll can time out at the wrong
 * moment, and the pane goes quiet with a live process behind it.
 *
 * OpenCode is the one CLI with a real server (`opencode serve`), so its loop
 * does not have to be a suggestion. Boxaide runs the server headless and holds
 * the loop itself: it waits on the channel in-process — a direct method call,
 * so there is no HTTP hop that can disconnect — and hands each user turn to the
 * server as a session prompt. The reply comes back on the same path `chat_say`
 * uses, so the lease, `replyTo`, history and SSE are all unchanged.
 *
 * The MCP tier is untouched and stays the fallback. Only the OpenCode launch
 * path is driven, and the loop's own chat tools are turned off per session: two
 * askers on one channel is the double-answer hole the lease exists to close.
 *
 * The loop itself is `runDrivenLoop` in driver.ts, shared with the Claude Code
 * driver — including what happens on a failed turn: the lease goes back, the
 * message re-queues instead of dying with the request, and the retry runs on
 * backoff. This one passes no failure cap: the server may come back, and the
 * child running it is still the process the user sees.
 */
import type { ChildProcess } from "node:child_process";
import {
  abortablePause,
  backoffMs,
  DRIVEN_SYSTEM,
  RETRY_BASE_MS,
  runDrivenLoop,
  TITLE_PROMPT,
  watchdogTickMs,
  WATCHDOG_MS,
  type AgentDriver,
  type DriverChannel,
} from "./driver.js";

/** How long to wait for `opencode serve` to announce its port. */
const READY_MS = 60_000;

/**
 * The loop's own chat tools, disabled for a driven session.
 *
 * Boxaide's MCP server is still configured for this agent — it is how the
 * model reads mail — but the driver already holds the lease. A model that also
 * called `chat_await_message` would be a second asker: it could take the
 * message out from under the loop, and it would cost the channel the right to
 * let the child's own liveness speak for the claim.
 *
 * `chat_history` is deliberately not here. It takes no lease and answers the one
 * question a driven model cannot answer any other way — what was said before the
 * turn it is holding — which is exactly what a session that lost its transcript
 * needs. DRIVEN_SYSTEM says so too.
 *
 * Both the bare and the OpenCode-namespaced spelling are sent. An unknown key
 * in this map is ignored, and guessing one spelling wrong is not worth it.
 */
const DISABLED_TOOLS = [
  "chat_await_message",
  "chat_say",
  "chat_activity",
].flatMap((name) => [name, `boxaide_${name}`, `boxaide*${name}`]);

export type OpenCodeDriverOptions = {
  channel: DriverChannel;
  /** Client name every turn is stamped with. The registry id, "opencode". */
  agent: string;
  /** Base URL of the running server, or a promise of it once it announces. */
  baseUrl: string | Promise<string>;
  /** The isolated agent workdir, passed as `?directory=` on every call. */
  directory: string;
  /** OPENCODE_SERVER_PASSWORD, when the server was started with one. */
  password?: string | null;
  /** Registry model id, or null for the server's own default. */
  model?: string | null;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  waitMs?: number;
  retryBaseMs?: number;
  watchdogMs?: number;
};

/**
 * One line off `GET /event`.
 *
 * Only the fields the driver reads are named. The stream carries far more, and
 * every unknown type falls through untouched.
 */
type ServerEvent = {
  type?: unknown;
  properties?: {
    sessionID?: unknown;
    field?: unknown;
    part?: { type?: unknown; tool?: unknown; name?: unknown };
  };
};

export class OpenCodeDriver implements AgentDriver {
  private abort = new AbortController();
  private stopped = false;
  /**
   * Sessions with a prompt in flight right now.
   *
   * The stream carries every session the server is running, and only the ones
   * this driver is waiting on say anything about the turn the watchdog is
   * guarding. A set rather than a single id because a chat's naming call can
   * still be running when the next chat's turn starts.
   */
  private inFlight = new Set<string>();
  /** Aborts the prompt POST alone, when the watchdog gives up on it. */
  private promptAbort: AbortController | null = null;
  /** When this session last showed a sign of life. Only the watchdog reads it. */
  private lastSessionEvent = 0;
  /** The naming call for the last answered turn, while it is still running. */
  private naming: Promise<void> | null = null;
  /** Resolves when the loop has left `run`. Tests await it; production does not. */
  readonly done: Promise<void>;
  private release!: () => void;

  constructor(private opts: OpenCodeDriverOptions) {
    this.done = new Promise<void>((resolve) => (this.release = resolve));
  }

  /** Starts the loop. Returns immediately; failures live inside the loop. */
  start(): this {
    this.opts.channel.setDriven(true);
    void this.run()
      .catch(() => {
        // The server child's own exit is what the user is told about, so there
        // is nothing to report here — but nothing awaits this promise either,
        // and an unhandled rejection would end the whole Boxaide process.
      })
      .then(() => {
        // However the loop ended, the chat tools go back to the MCP tier.
        this.opts.channel.setDriven(false);
        this.release();
      });
    return this;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    // The per-prompt controller is chained to this one, so this is belt and
    // braces for a POST that started in the gap before the chain was hooked up.
    this.promptAbort?.abort();
  }

  private async run(): Promise<void> {
    let base: string;
    try {
      base = await this.opts.baseUrl;
    } catch {
      // No server, no loop. The child's own exit is what the user is told
      // about; a driver that cannot reach it has nothing to add.
      return;
    }
    // Opened once and kept for the driver's life: it is what makes a turn
    // visible while it runs, and what the watchdog listens to.
    void this.watchEvents(base);
    // No failure cap: the server may come back, and the child running it is
    // still the process the user sees. Ending this loop would leave that server
    // up with nobody prompting it.
    await runDrivenLoop(
      {
        channel: this.opts.channel,
        agent: this.opts.agent,
        signal: this.abort.signal,
        stopped: () => this.stopped,
        waitMs: this.opts.waitMs,
        retryBaseMs: this.opts.retryBaseMs,
        beforeTurn: () => this.naming ?? Promise.resolve(),
        afterReply: (chatId) => {
          this.naming = this.maybeName(base, chatId).finally(() => {
            this.naming = null;
          });
        },
      },
      (turn) => this.prompt(base, turn.chatId, turn.text),
    );
  }

  /**
   * Names the chat, once, from the exchange that just happened.
   *
   * The MCP tier gets this for free — the agent passes a title to `chat_say`
   * — and a driven session has no chat tools to pass it through, so the name is
   * asked for directly. It runs on the same session, so the model is naming a
   * conversation it has just had rather than being handed one to read.
   *
   * Everything here is best effort. The answer is already posted and the lease
   * is already closed, so a failed or refused title costs the user nothing and
   * must never reach the loop's retry path: the chat keeps the name its first
   * message gave it.
   */
  private async maybeName(base: string, chatId: string): Promise<void> {
    try {
      if (this.stopped) return;
      if (!this.opts.channel.needsTitle(chatId)) return;
      const raw = await this.prompt(base, chatId, TITLE_PROMPT, { background: true });
      this.opts.channel.nameChat(chatId, raw);
    } catch {
      // No name is a fine outcome. See the note above. The whole body is
      // guarded, not just the prompt: this promise is awaited by the loop, and
      // a throw from it would be read as a failed answer.
    }
  }

  /**
   * One prompt, blocking until the turn completes. Throws on any failure.
   *
   * `background` marks a prompt that is not the user's turn. A failed turn
   * takes the session down with it, which is right when the message is going
   * back on the queue to be asked again — and wrong for a naming call, where
   * the cost of that would land on the conversation instead: the next thing
   * the user asked would be answered by a model that had forgotten the last
   * one, with nothing on screen to explain it. A background failure leaves the
   * session alone. If it really did wedge the session, the next user turn
   * fails once and resets it on the visible path, message and all.
   */
  private async prompt(
    base: string,
    chatId: string,
    text: string,
    options: { background?: boolean } = {},
  ): Promise<string> {
    const session = await this.ensureSession(base, chatId);
    this.inFlight.add(session);
    // Armed across the body read too, not just the headers: a server that
    // flushes headers early and streams the body would otherwise spend the
    // whole turn outside the watchdog. Aborting the guard rejects the read.
    const guard = this.startWatchdog();
    let body: { parts?: Array<{ type?: string; text?: string }> };
    try {
      const res = await this.call(
        base,
        `/session/${session}/message`,
        {
          parts: [{ type: "text", text }],
          system: DRIVEN_SYSTEM,
          tools: Object.fromEntries(DISABLED_TOOLS.map((name) => [name, false])),
          ...(this.opts.model ? { model: splitModel(this.opts.model) } : {}),
        },
        guard.signal,
      );
      if (!res.ok) throw new Error(`opencode message failed: ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (err) {
      // Whatever failed — dropped connection, watchdog abort, bad status — the
      // server may still be running the turn on this session, and the next
      // attempt on the same session would 409 into it. Tell it to stop, take a
      // fresh session next time, and let the caller re-queue the message.
      // This chat's session only: the other chats' sessions are untouched by a
      // turn that failed in this one.
      if (!options.background) {
        this.opts.channel.clearChatSession(chatId);
        void this.call(base, `/session/${session}/abort`, {}).catch(() => {});
      }
      throw err;
    } finally {
      this.inFlight.delete(session);
      guard.end();
    }
    const reply = (body.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    // An empty turn is a failed turn. Posting nothing would end the lease with
    // a blank answer in the pane; treating it as an error re-queues instead.
    if (!reply) throw new Error("opencode returned no text");
    return reply;
  }

  /**
   * The server session this chat's turns run in, made on first use.
   *
   * Per chat, not per driver: one running agent answers every chat, and a
   * shared session would put every conversation in one transcript. The id is
   * kept in the store, so a restarted agent picks each conversation back up —
   * the server's directory is the stable agent workdir.
   */
  private async ensureSession(base: string, chatId: string): Promise<string> {
    const { id: known, epoch } = this.opts.channel.chatSession(
      chatId,
      this.opts.agent,
    );
    if (known) return known;
    const res = await this.call(base, "/session", {
      title: "Boxaide",
      // The old chat launch ran `--auto`; this is the same grant, per session.
      // Without it a stricter user config makes the server park the turn on a
      // permission question nobody is around to answer. Shape verified against
      // opencode serve 1.18.15 (the map form is rejected with a 400).
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      ...(this.opts.model ? { model: sessionModel(this.opts.model) } : {}),
    });
    if (!res.ok) throw new Error(`opencode session failed: ${res.status}`);
    const body = (await res.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      throw new Error("opencode session response had no id");
    }
    // On the epoch read before the POST above: a chat cleared while the server
    // was making this session must not have that session saved under it.
    this.opts.channel.saveChatSession(chatId, this.opts.agent, body.id, epoch);
    return body.id;
  }

  private call(
    base: string,
    path: string,
    body: unknown,
    signal: AbortSignal = this.abort.signal,
  ): Promise<Response> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    return doFetch(this.url(base, path), {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
      signal,
    });
  }

  /**
   * Arms the watchdog for one prompt.
   *
   * The POST gets its own controller, chained to the driver's: aborting it ends
   * that request and nothing else, so `run`'s existing catch gives the message
   * back and retries, while the event stream and the loop stay up. Starting the
   * POST counts as a sign of life — otherwise a turn whose first part takes
   * longer than the window would be killed before the server had said anything.
   */
  private startWatchdog(): { signal: AbortSignal; end: () => void } {
    const ms = this.opts.watchdogMs ?? WATCHDOG_MS;
    const controller = new AbortController();
    this.promptAbort = controller;
    const onStop = () => controller.abort();
    if (this.abort.signal.aborted) onStop();
    else this.abort.signal.addEventListener("abort", onStop, { once: true });
    this.lastSessionEvent = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - this.lastSessionEvent >= ms) controller.abort();
    }, watchdogTickMs(ms));
    return {
      signal: controller.signal,
      end: () => {
        clearInterval(timer);
        this.abort.signal.removeEventListener("abort", onStop);
        if (this.promptAbort === controller) this.promptAbort = null;
      },
    };
  }

  /**
   * The event stream, reconnected for as long as the driver runs.
   *
   * A drop is not a failed turn — the prompt POST is a separate request and may
   * still be running — so this reconnects on the same backoff the loop uses and
   * says nothing to the channel. Bytes arriving are what counts as a working
   * connection, and reset the backoff.
   */
  private async watchEvents(base: string): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        if (await this.readEvents(base)) failures = 0;
      } catch {
        // Refused, dropped, or aborted: the loop below decides which.
      }
      if (this.stopped) return;
      failures += 1;
      await this.pause(failures);
    }
  }

  /** One connection. Resolves true if it ever delivered bytes. */
  private async readEvents(base: string): Promise<boolean> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(this.url(base, "/event"), {
      headers: { accept: "text/event-stream", ...this.authHeaders() },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`opencode event failed: ${res.status}`);
    let live = false;
    let buffer = "";
    const decoder = new TextDecoder();
    // The stream has no `event:` field and no framing beyond the blank line, so
    // lines are all this has to split on.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      live = true;
      buffer += decoder.decode(chunk, { stream: true });
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line.startsWith("data:")) this.onEvent(line.slice(5).trim());
        cut = buffer.indexOf("\n");
      }
    }
    return live;
  }

  /** One `data:` line. Anything unreadable or unrelated is dropped. */
  private onEvent(raw: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    const props = event.properties;
    // `server.connected` and `server.heartbeat` carry no session and are
    // deliberately not proof of anything here: a live server heartbeats just as
    // steadily while the turn it is holding has stopped moving. Only the
    // session's own events say the turn is still being worked.
    if (typeof props?.sessionID !== "string" || !this.inFlight.has(props.sessionID)) {
      return;
    }
    this.lastSessionEvent = Date.now();
    if (event.type === "message.part.updated" && props.part?.type === "tool") {
      const name = props.part.tool ?? props.part.name;
      if (typeof name === "string" && name) {
        // No throttle here: the channel already decides how often a step is
        // worth emitting, and a second one would only add lag.
        this.opts.channel.noteAgentActivity(name);
      }
    } else if (event.type === "message.part.delta" && props.field === "text") {
      // Text arriving is the answer being written. There is no tool to name.
      this.opts.channel.noteAgentActivity("responding");
    }
  }

  /**
   * The working directory is a query parameter on every v1 call, the event
   * stream included. Omit it and the session silently binds to the server
   * process's own cwd.
   */
  private url(base: string, path: string): string {
    return `${base}${path}?directory=${encodeURIComponent(this.opts.directory)}`;
  }

  private authHeaders(): Record<string, string> {
    return this.opts.password
      ? { authorization: `Basic ${basic(this.opts.password)}` }
      : {};
  }

  /** Abortable backoff, so stop() during a wait is immediate. */
  private pause(failures: number): Promise<void> {
    return abortablePause(
      this.abort.signal,
      backoffMs(failures, this.opts.retryBaseMs ?? RETRY_BASE_MS),
    );
  }
}

/** OpenCode's own username. Overriding it is a server-side env var we do not set. */
function basic(password: string): string {
  return Buffer.from(`opencode:${password}`).toString("base64");
}

/** Registry ids are `provider/model`; the two APIs spell the pair differently. */
function splitModel(id: string): { providerID: string; modelID: string } {
  const cut = id.indexOf("/");
  return cut < 0
    ? { providerID: "opencode", modelID: id }
    : { providerID: id.slice(0, cut), modelID: id.slice(cut + 1) };
}

function sessionModel(id: string): { providerID: string; id: string } {
  const { providerID, modelID } = splitModel(id);
  return { providerID, id: modelID };
}

/**
 * The URL `opencode serve` prints once it is listening.
 *
 * The port is asked for as 0 and read back rather than picked here: a port
 * chosen in advance can be taken by the time the child binds it. This attaches
 * a second `data` listener to stdout — the launcher's own reader keeps the
 * pipe drained either way.
 */
export function serveBaseUrl(
  child: ChildProcess,
  options: { readyMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => {
      finish();
      reject(new Error("opencode serve did not announce a port"));
    }, options.readyMs ?? READY_MS);
    const onData = (chunk: string | Buffer) => {
      seen += chunk.toString();
      const match = seen.match(/listening on (https?:\/\/[^\s]+)/i);
      if (!match) return;
      finish();
      resolve(match[1].replace(/\/+$/, ""));
    };
    const onClose = () => {
      finish();
      reject(new Error("opencode serve exited before listening"));
    };
    function finish() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("close", onClose);
    }
    child.stdout?.on("data", onData);
    child.on("close", onClose);
  });
}

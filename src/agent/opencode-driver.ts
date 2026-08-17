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
 * path is driven, and a driven session's own chat tools are turned off in the
 * prompt: two askers on one channel is the double-answer hole the lease exists
 * to close.
 *
 * On any API failure the lease goes back (`releaseLease`), so the message
 * re-queues instead of dying with the request, and the loop retries with
 * backoff until the delivery cap dead-letters it.
 */
import type { ChildProcess } from "node:child_process";
import { MAX_WAIT_MS } from "./channel.js";

/**
 * What the driver needs from the conversation channel.
 *
 * Structural on purpose: the driver is a loop over four calls, and stating
 * only those four is what makes it testable without a database.
 */
export type DriverChannel = {
  awaitUserTurn(options: {
    timeoutMs?: number;
    agent?: string | null;
    signal?: AbortSignal;
  }): Promise<{ seq: number; text: string; chatId: string } | null>;
  post(input: { role: "agent" | "activity"; text: string; agent?: string | null }): unknown;
  releaseLease(seq: number, options?: { revertAttempt?: boolean }): void;
  noteAgentActivity(tool: string | null): void;
  /** Gates the MCP chat tools while this loop owns the conversation. */
  setDriven(on: boolean): void;
  /** True while the chat is still carrying the user's first line as its name. */
  needsTitle(chatId: string): boolean;
  /** Offers the model's name for the chat. Refused if the user named it. */
  nameChat(chatId: string, title: string): boolean;
};

/** A running driver, from the launcher's side. Stopping is idempotent. */
export type AgentDriver = { stop(): void };

/** Backoff after a failed turn: doubles, capped, so a dead server is cheap. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** How long to wait for `opencode serve` to announce its port. */
const READY_MS = 60_000;

/**
 * How long a prompt may run without a single event for its session.
 *
 * The prompt POST blocks until the turn finishes, and a turn can legitimately
 * take minutes — so time alone says nothing. Silence on the event stream does:
 * a working server reports every part it writes, so no part in three minutes is
 * a server that has stopped working on this turn. Only then is the POST worth
 * abandoning, which puts the message back on the queue instead of holding the
 * lease until the user gives up and stops the agent.
 */
const WATCHDOG_MS = 180_000;

/**
 * The chat tools, disabled for a driven session.
 *
 * Boxaide's MCP server is still configured for this agent — it is how the
 * model reads mail — but the driver already holds the lease. A model that also
 * called `chat_await_message` would be a second asker: it could take the
 * message out from under the loop, and it would cost the channel the right to
 * let the child's own liveness speak for the claim.
 *
 * Both the bare and the OpenCode-namespaced spelling are sent. An unknown key
 * in this map is ignored, and guessing one spelling wrong is not worth it.
 */
const DISABLED_TOOLS = [
  "chat_await_message",
  "chat_say",
  "chat_activity",
  "chat_history",
].flatMap((name) => [name, `boxaide_${name}`, `boxaide*${name}`]);

/**
 * What the model is told about the conversation it is in.
 *
 * The KICKOFF prompt cannot apply here: it describes a loop this code is
 * running. What is left is the part the model still has to know — that its
 * answer is read by a person in another window, and that it must not send mail.
 */
const DRIVEN_SYSTEM = `You are my Boxaide inbox agent. Use the Boxaide MCP tools to read mail.

Each message you receive is from me, typed in the Boxaide window. Reply with the
answer itself — your reply text is what I read. Do not call any chat_ tool; the
conversation is handled for you. Draft rather than send unless I ask you to send.`;

/**
 * The one question asked purely to name a chat.
 *
 * Written for a model that has just answered a person and is inclined to keep
 * talking: it says what the answer is for, bans the decorations models put
 * around a title anyway, and gives an example of the difference between a name
 * and a category.
 */
const TITLE_PROMPT = `Name this conversation for a list I will read a week from now.
Four words or fewer, describing what it is actually about — "Refund for the Acme
invoice", not "Email question". Reply with the name alone: no quotes, no
punctuation at the end, no explanation. This is not a message to me.`;

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
  private sessionId: string | null = null;
  /** Aborts the prompt POST alone, when the watchdog gives up on it. */
  private promptAbort: AbortController | null = null;
  /** When this session last showed a sign of life. Only the watchdog reads it. */
  private lastSessionEvent = 0;
  /** Resolves when the loop has left `run`. Tests await it; production does not. */
  readonly done: Promise<void>;
  private release!: () => void;

  constructor(private opts: OpenCodeDriverOptions) {
    this.done = new Promise<void>((resolve) => (this.release = resolve));
  }

  /** Starts the loop. Returns immediately; failures live inside the loop. */
  start(): this {
    this.opts.channel.setDriven(true);
    void this.run().finally(() => {
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
    let failures = 0;
    while (!this.stopped) {
      const turn = await this.opts.channel.awaitUserTurn({
        timeoutMs: this.opts.waitMs ?? MAX_WAIT_MS,
        agent: this.opts.agent,
        signal: this.abort.signal,
      });
      // Null is the normal timeout, and the whole point of asking again.
      if (!turn) continue;
      if (this.stopped) {
        this.opts.channel.releaseLease(turn.seq, { revertAttempt: true });
        return;
      }
      try {
        this.opts.channel.noteAgentActivity("prompt");
        const reply = await this.prompt(base, turn.text);
        this.opts.channel.post({
          role: "agent",
          text: reply,
          agent: this.opts.agent,
        });
        failures = 0;
        await this.maybeName(base, turn.chatId);
      } catch {
        if (this.stopped) {
          this.opts.channel.releaseLease(turn.seq, { revertAttempt: true });
          return;
        }
        // Give the message back rather than swallow it: the next attempt is
        // handed the same turn, and the delivery cap ends it if the server
        // stays broken.
        this.opts.channel.releaseLease(turn.seq);
        failures += 1;
        await this.pause(failures);
      }
    }
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
    if (this.stopped) return;
    if (!this.opts.channel.needsTitle(chatId)) return;
    try {
      const raw = await this.prompt(base, TITLE_PROMPT);
      this.opts.channel.nameChat(chatId, raw);
    } catch {
      // No name is a fine outcome. See the note above.
    }
  }

  /** One prompt, blocking until the turn completes. Throws on any failure. */
  private async prompt(base: string, text: string): Promise<string> {
    const session = await this.ensureSession(base);
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
      this.sessionId = null;
      void this.call(base, `/session/${session}/abort`, {}).catch(() => {});
      throw err;
    } finally {
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

  private async ensureSession(base: string): Promise<string> {
    if (this.sessionId) return this.sessionId;
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
    this.sessionId = body.id;
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
    const timer = setInterval(
      () => {
        if (Date.now() - this.lastSessionEvent >= ms) controller.abort();
      },
      Math.max(10, Math.min(ms / 4, 5_000)),
    );
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
    if (!props || !this.sessionId || props.sessionID !== this.sessionId) return;
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
    const base = this.opts.retryBaseMs ?? RETRY_BASE_MS;
    const ms = Math.min(base * 2 ** (failures - 1), RETRY_MAX_MS);
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      const signal = this.abort.signal;
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      if (signal.aborted) return finish();
      signal.addEventListener("abort", finish, { once: true });
    });
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

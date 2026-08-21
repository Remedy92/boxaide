/**
 * The in-process Claude Code loop, tested the way it runs: a real AgentChannel
 * over a real (in-memory) store, and real child processes standing in for
 * `claude -p`. Nothing here is mocked except the CLI itself — the stand-in is a
 * node script that prints the stream-json shapes the real one prints, so the
 * spawn, the pipes, the exit codes and the SIGKILL are all genuine.
 *
 * The shapes it prints were captured from claude 2.1.233:
 *   {"type":"system","subtype":"init","session_id":"…", …}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}, …}
 *   {"type":"result","subtype":"success","is_error":false,"result":"…", …}
 *   {"type":"result","subtype":"error_during_execution","is_error":true,
 *    "errors":["No conversation found with session ID: …"], …}
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentChannel } from "../src/agent/channel.js";
import { ClaudeDriver } from "../src/agent/claude-driver.js";
import { DRIVEN_SYSTEM } from "../src/agent/driver.js";
import { MAX_DELIVERIES, Store } from "../src/db/store.js";

/**
 * One scripted invocation. Entries are consumed in order and the last one
 * repeats, so a single-entry script is a CLI that always behaves that way.
 */
type Step = {
  /** The session id every line of this invocation reports. */
  session?: string;
  /** Tool names to announce before the result, as assistant content blocks. */
  tools?: string[];
  /** The answer, as the result event's text. */
  answer?: string;
  /** Fail instead. `$RESUME` is replaced with the id this call was given. */
  errors?: string[];
  /** Print the init line and then never exit: the case the watchdog is for. */
  hang?: boolean;
  /** Answer, then never exit — and ignore SIGTERM while doing it. */
  deaf?: boolean;
  /** Write the result event without a closing newline. */
  noNewline?: boolean;
  /** Pad the answer to this many characters. */
  pad?: number;
  /**
   * Announce the turn, then hold it until the test releases it. What a long
   * answer looks like from outside: the test gets to act on the chat while the
   * model is demonstrably still working on it.
   */
  slow?: boolean;
  /**
   * Report subtype "success" with nothing on it. What a signed-out CLI was
   * actually observed doing, and what reached the user as "claude: success".
   */
  empty?: boolean;
};

/**
 * The fake CLI. Reads its script from a file rather than argv, because the
 * driver owns the command line and only the launcher decides what is on it.
 */
const FAKE_CLI = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + "\\n");
const calls = fs.readFileSync(process.env.FAKE_LOG, "utf8").trim().split("\\n").length;
const steps = JSON.parse(fs.readFileSync(process.env.FAKE_SCRIPT, "utf8"));
const step = steps[Math.min(calls - 1, steps.length - 1)];
const at = argv.indexOf("--resume");
const resume = at >= 0 ? argv[at + 1] : null;
const session = step.session || resume || "ses-fresh";
const say = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: session }) + "\\n");
say({ type: "system", subtype: "init", tools: [] });
for (const tool of step.tools || []) {
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: tool }] } });
}
const answer = step.pad ? (step.answer || "").padEnd(step.pad, "x") : step.answer;
if (step.hang) {
  // Alive, silent, and holding the turn: a live process with a dead turn behind
  // it, which elapsed time alone cannot tell from a slow one.
  setInterval(() => {}, 1000);
} else if (step.deaf) {
  // Answered, still printing, and deaf to SIGTERM: only SIGKILL ends this, and
  // the watchdog never fires because it is not silent. The marker file is
  // written only once the result line has reached the pipe, so a test that
  // wants to kill this child after its answer has something real to wait on —
  // stopping on any earlier signal races the SIGKILL against the write.
  process.on("SIGTERM", () => {});
  process.stdout.write(
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer, session_id: session }) + "\\n",
    () => fs.writeFileSync(process.env.FAKE_ANSWERED, ""),
  );
  setInterval(() => say({ type: "system", subtype: "still_here" }), 20);
} else if (step.slow) {
  // Says it started, then waits to be let go. The turn is genuinely in flight
  // for as long as the test wants it to be.
  fs.writeFileSync(process.env.FAKE_STARTED, "");
  const tick = setInterval(() => {
    if (!fs.existsSync(process.env.FAKE_RELEASE)) return;
    clearInterval(tick);
    say({ type: "result", subtype: "success", is_error: false, result: answer });
    process.exit(0);
  }, 10);
} else if (step.noNewline) {
  // The last write of a turn, unterminated: a reader that only emits on newline
  // scores this finished turn as no answer. Exit once it has drained, or a write
  // this size is simply discarded and the test would prove nothing.
  process.stdout.write(
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer, session_id: session }),
    () => process.exit(0),
  );
} else if (step.empty) {
  say({ type: "result", subtype: "success" });
  process.exit(0);
} else if (step.errors) {
  say({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: step.errors.map((e) => e.replace("$RESUME", resume || "")),
  });
  process.exit(1);
} else {
  say({ type: "result", subtype: "success", is_error: false, result: answer });
  process.exit(0);
}
`;

type Fake = {
  /** Path to pass as the driver's `bin` argument's script. */
  script: string;
  env: NodeJS.ProcessEnv;
  /** argv of every invocation, in order. */
  calls: () => string[][];
  /** True once a deaf step's result line has reached the pipe. */
  answered: () => boolean;
  /** True once a slow step has announced its turn. */
  started: () => boolean;
  /** Lets a slow step finish. */
  release: () => void;
};

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function fakeCli(steps: Step[]): Fake {
  const dir = mkdtempSync(join(tmpdir(), "boxaide-claude-driver-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "fake-claude.cjs");
  const log = join(dir, "calls.ndjson");
  writeFileSync(script, FAKE_CLI);
  writeFileSync(join(dir, "steps.json"), JSON.stringify(steps));
  const answered = join(dir, "answered");
  const started = join(dir, "started");
  const release = join(dir, "release");
  return {
    script,
    env: {
      ...process.env,
      FAKE_LOG: log,
      FAKE_SCRIPT: join(dir, "steps.json"),
      FAKE_ANSWERED: answered,
      FAKE_STARTED: started,
      FAKE_RELEASE: release,
    },
    answered: () => existsSync(answered),
    started: () => existsSync(started),
    release: () => writeFileSync(release, ""),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

function make(): { store: Store; channel: AgentChannel } {
  const store = new Store(randomBytes(32), ":memory:");
  const channel = new AgentChannel(store);
  cleanup.push(() => {
    channel.close();
    store.close();
  });
  return { store, channel };
}

/**
 * The argv the driver is given for a turn. Deliberately not the launcher's own
 * builder: this file tests the loop, and agent-launcher.test.ts tests the flags.
 * Everything the loop is responsible for putting on a command line — the
 * prompt, the framing, the session to resume — is here and nothing else is.
 */
function argsFor(script: string) {
  return (turn: { prompt: string; system: string; sessionId: string | null }): string[] => [
    script,
    "-p",
    turn.prompt,
    "--append-system-prompt",
    turn.system,
    ...(turn.sessionId ? ["--resume", turn.sessionId] : []),
  ];
}

function drive(
  channel: AgentChannel,
  fake: Fake,
  over: Partial<{
    waitMs: number;
    retryBaseMs: number;
    watchdogMs: number;
    maxFailures: number;
    stopGraceMs: number;
    healAuth: () => boolean;
    onStop: (error: string | null, cause: { authRequired: boolean }) => void;
    memorySystem: () => string;
  }> = {},
): ClaudeDriver {
  const driver = new ClaudeDriver({
    channel,
    agent: "claude-code",
    bin: process.execPath,
    argsFor: argsFor(fake.script),
    cwd: tmpdir(),
    env: fake.env,
    waitMs: 1_000,
    retryBaseMs: 10,
    ...over,
  }).start();
  cleanup.push(() => driver.stop());
  return driver;
}

function isNaming(argv: string[]): boolean {
  return argv.some((arg) => arg.startsWith("Name this conversation"));
}

function userCalls(fake: { calls: () => string[][] }): string[][] {
  return fake.calls().filter((argv) => !isNaming(argv));
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("ClaudeDriver", () => {
  it("answers a user turn from the result event and carries the session forward", async () => {
    const fake = fakeCli([
      { session: "ses-1", answer: "two invoices came in" },
      { answer: "and one reply" },
    ]);
    const { channel } = make();
    const driver = drive(channel, fake);

    const first = channel.post({ role: "user", text: "what came in today?" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    const answer = channel.history().find((t) => t.role === "agent")!;
    expect(answer.text).toBe("two invoices came in");
    // Same path chat_say takes: stamped as the agent, tied to the user turn.
    expect(answer.replyTo).toBe(first.seq);
    expect(answer.agent).toBe("claude-code");
    // The lease ended with the answer.
    expect(channel.presence().working).toBeNull();

    const opened = userCalls(fake)[0];
    // The user's message is the whole prompt, and the framing rides beside it.
    expect(opened[opened.indexOf("-p") + 1]).toBe("what came in today?");
    expect(opened[opened.indexOf("--append-system-prompt") + 1]).toBe(DRIVEN_SYSTEM);
    // Nothing to resume on the first turn of a session.
    expect(opened).not.toContain("--resume");

    const second = channel.post({ role: "user", text: "anything else?" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 2);

    const followUp = channel.history().filter((t) => t.role === "agent")[1];
    expect(followUp.text).toBe("and one reply");
    expect(followUp.replyTo).toBe(second.seq);
    // The whole point of the second process: it continues the first one's
    // conversation instead of meeting the user for the first time.
    const resumed = userCalls(fake)[1];
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("ses-1");

    driver.stop();
    await driver.done;
  });

  it("appends the workspace-memory block to the framing of every turn", async () => {
    const fake = fakeCli([{ answer: "noted" }]);
    const { channel } = make();
    const driver = drive(channel, fake, { memorySystem: () => "MEMORY BLOCK" });

    channel.post({ role: "user", text: "what came in today?" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    const opened = userCalls(fake)[0];
    // The block rides DRIVEN_SYSTEM, not the user's message: the framing is
    // re-sent every turn, so the notes are too.
    expect(opened[opened.indexOf("--append-system-prompt") + 1]).toBe(
      `${DRIVEN_SYSTEM}\n\nMEMORY BLOCK`,
    );

    driver.stop();
    await driver.done;
  });

  /**
   * The agent writes its notes mid-session, so the block a launch read first
   * is stale by the second turn: it still says there are none and asks to
   * build them again. The driver must read per turn, not once.
   */
  it("re-reads the memory block on each turn", async () => {
    const fake = fakeCli([
      { session: "ses-a", answer: "one" },
      { session: "ses-a", answer: "two" },
    ]);
    const { channel } = make();
    const blocks = ["NO NOTES YET", "MEMORY.md: company.md"];
    let reads = 0;
    const driver = drive(channel, fake, {
      memorySystem: () => blocks[Math.min(reads++, blocks.length - 1)]!,
    });

    channel.post({ role: "user", text: "first" });
    await until(
      () => channel.history().filter((t) => t.role === "agent").length === 1,
    );
    channel.post({ role: "user", text: "second" });
    await until(
      () => channel.history().filter((t) => t.role === "agent").length === 2,
    );

    const framings = userCalls(fake).map(
      (call) => call[call.indexOf("--append-system-prompt") + 1],
    );
    expect(framings[0]).toBe(`${DRIVEN_SYSTEM}\n\nNO NOTES YET`);
    expect(framings[1]).toBe(`${DRIVEN_SYSTEM}\n\nMEMORY.md: company.md`);

    driver.stop();
    await driver.done;
  });

  it("stops the turn in flight and stays up for the next message", async () => {
    const fake = fakeCli([
      { session: "ses-a", answer: "never arrives", slow: true },
      { session: "ses-b", answer: "still here" },
    ]);
    const { store, channel } = make();
    const driver = drive(channel, fake);

    const question = channel.post({ role: "user", text: "read everything" });
    await until(() => fake.started());
    expect(channel.presence().working?.seq).toBe(question.seq);

    // The route's own order: close the message first, then kill the turn. The
    // other way round hands the message straight back to the agent that is
    // being stopped.
    expect(channel.cancelWork(question.seq)?.seq).toBe(question.seq);
    expect(driver.interrupt(question.seq)).toBe(true);

    // The run is over on the pane, and the transcript says so where the answer
    // would have been.
    await until(() => !channel.presence().working);
    const stopped = channel.history().find((t) => t.role === "agent")!;
    expect(stopped.text).toBe("Stopped.");
    expect(stopped.replyTo).toBe(question.seq);
    // Stopped, not dropped: the message was answered, so nothing re-delivers it
    // and no warning is owed about it.
    expect(store.listDroppedUserSeqs()).toEqual([]);

    // The agent is still running: the next message is taken, and the killed
    // turn was not handed over a second time.
    channel.post({ role: "user", text: "what about now?" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 2);
    const answer = channel.history().filter((t) => t.role === "agent")[1];
    expect(answer.text).toBe("still here");
    const asked = userCalls(fake).map((argv) => argv[argv.indexOf("-p") + 1]);
    expect(asked).toEqual(["read everything", "what about now?"]);

    driver.stop();
    await driver.done;
  });

  it("has nothing to stop when no turn is running", async () => {
    const fake = fakeCli([{ answer: "done" }]);
    const { channel } = make();
    const driver = drive(channel, fake);

    expect(channel.cancelWork(1)).toBeNull();
    expect(channel.cancelWork()).toBeNull();

    driver.stop();
    await driver.done;
  });

  it("does not stop a message other than the one asked for", async () => {
    const fake = fakeCli([{ answer: "the long answer", slow: true }]);
    const { channel } = make();
    const driver = drive(channel, fake);

    const question = channel.post({ role: "user", text: "read everything" });
    await until(() => fake.started());

    // The pane was showing Stop for a run that has since finished; the seq it
    // names is not the one in flight. Nothing is stopped and nothing is said.
    expect(channel.cancelWork(question.seq - 1)).toBeNull();
    expect(channel.presence().working?.seq).toBe(question.seq);
    expect(channel.history().some((t) => t.role === "agent")).toBe(false);

    fake.release();
    await until(() => channel.history().some((t) => t.role === "agent"));
    expect(channel.history().find((t) => t.role === "agent")!.text).toBe("the long answer");

    driver.stop();
    await driver.done;
  });

  it("does not prompt for a turn stopped while the naming call was still running", async () => {
    const fake = fakeCli([
      // The first turn answers, which starts the naming call — and that call is
      // the one left holding the CLI while the next message is claimed.
      { session: "ses-a", answer: "first answer" },
      { session: "ses-a", answer: "First question", slow: true },
      { session: "ses-a", answer: "must never be asked" },
    ]);
    const { store, channel } = make();
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "first question" });
    await until(() => channel.history().some((t) => t.role === "agent"));
    // The naming call is in flight and holding the only child there is.
    await until(() => fake.started());

    // The next message is claimed while the loop waits on that naming call: the
    // pane shows Stop, and there is no process for this turn to kill yet.
    const stopped = channel.post({ role: "user", text: "read everything" });
    await until(() => channel.presence().working?.seq === stopped.seq);
    expect(channel.cancelWork(stopped.seq)?.seq).toBe(stopped.seq);
    expect(driver.interrupt(stopped.seq)).toBe(true);

    // Let the naming call finish. The loop reaches the stopped turn and must
    // refuse to ask it: three invocations would mean the CLI was prompted for a
    // question the user had already stopped.
    fake.release();
    await until(() => !channel.presence().working);
    await new Promise((r) => setTimeout(r, 200));
    expect(userCalls(fake)).toHaveLength(1);
    expect(channel.history().filter((t) => t.role === "agent").map((t) => t.text)).toEqual([
      "first answer",
      "Stopped.",
    ]);
    expect(store.listDroppedUserSeqs()).toEqual([]);

    driver.stop();
    await driver.done;
  });

  it("releases the lease and retries when a turn fails", async () => {
    const fake = fakeCli([
      { errors: ["Overloaded"] },
      { answer: "second time lucky" },
    ]);
    const { store, channel } = make();
    const driver = drive(channel, fake);

    const user = channel.post({ role: "user", text: "retry me" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    expect(userCalls(fake)).toHaveLength(2);
    // The failed turn went back on the queue and was handed over again, so the
    // same message was answered rather than lost with the process.
    const answer = channel.history().find((t) => t.role === "agent")!;
    expect(answer.text).toBe("second time lucky");
    expect(answer.replyTo).toBe(user.seq);
    expect(store.listDroppedUserSeqs()).toEqual([]);

    driver.stop();
    await driver.done;
  });

  it("starts a fresh session when the CLI refuses the one it was given", async () => {
    const fake = fakeCli([
      { session: "ses-gone", answer: "first answer" },
      { session: "ses-gone", answer: "First question" },
      { errors: ["No conversation found with session ID: $RESUME"] },
      { session: "ses-new", answer: "still here" },
    ]);
    const { store, channel } = make();
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "first question" });
    await until(() => channel.history().some((t) => t.role === "agent"));
    // Let the naming turn consume its own scripted step so the refuse is
    // the next user turn, not the name.
    await until(() => fake.calls().some(isNaming));

    const second = channel.post({ role: "user", text: "second question" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 2);

    const calls = userCalls(fake);
    expect(calls).toHaveLength(3);
    expect(calls[1][calls[1].indexOf("--resume") + 1]).toBe("ses-gone");
    // A session the CLI cannot find will never be found, so the retry stops
    // asking for it: the conversation loses its memory, not its next answer.
    expect(calls[2]).not.toContain("--resume");
    const answer = channel.history().filter((t) => t.role === "agent")[1];
    expect(answer.text).toBe("still here");
    expect(answer.replyTo).toBe(second.seq);
    expect(store.listDroppedUserSeqs()).toEqual([]);

    driver.stop();
    await driver.done;
  });

  it("shows the tool the model is running, and abandons a turn that goes quiet", async () => {
    const fake = fakeCli([
      { tools: ["Bash"], hang: true },
      { answer: "back on track" },
    ]);
    const { store, channel } = make();
    // Boxaide launched this agent, which is what lets its stream speak for the
    // open claim (see AgentChannel.streamSpeaksForWork).
    channel.setLaunchedAgent("claude-code");
    const driver = drive(channel, fake, { watchdogMs: 200, retryBaseMs: 50 });

    const user = channel.post({ role: "user", text: "read the config" });
    // Mid-turn, the only thing the pane can say is what the stream reported.
    await until(() => channel.presence().working?.tool?.name === "Bash");

    // Silent past the window: the child is killed, the lease goes back, and the
    // same message is handed over again.
    await until(() => channel.presence().working === null);
    await until(() => channel.history().some((t) => t.role === "agent"));

    expect(userCalls(fake)).toHaveLength(2);
    const answer = channel.history().find((t) => t.role === "agent")!;
    expect(answer.text).toBe("back on track");
    expect(answer.replyTo).toBe(user.seq);
    expect(store.listDroppedUserSeqs()).toEqual([]);

    driver.stop();
    await driver.done;
  });

  it("stops cleanly while parked on the channel", async () => {
    const fake = fakeCli([{ answer: "never asked" }]);
    const { channel } = make();
    const stops: Array<string | null> = [];
    const driver = drive(channel, fake, {
      waitMs: 100_000,
      onStop: (error) => stops.push(error),
    });

    // Parked in awaitUserTurn with a long timeout: only the abort ends it.
    await until(() => channel.presence().waiting === 1);
    expect(channel.driven).toBe(true);
    driver.stop();
    await driver.done;

    expect(channel.presence().waiting).toBe(0);
    // The gate lifts with the loop, so the MCP tier can take over again.
    expect(channel.driven).toBe(false);
    // Nothing was prompted, the stop reported no failure, and stopping twice is
    // a no-op.
    expect(fake.calls()).toEqual([]);
    expect(stops).toEqual([null]);
    driver.stop();
  });

  it("gives up on one queued message at the production failure cap", async () => {
    const fake = fakeCli([{ errors: ["Invalid API key"] }]);
    const { store, channel } = make();
    const stops: Array<string | null> = [];
    // No maxFailures override: this is the shipped configuration, and one typed
    // message has to be enough to reach the give-up. Every failed turn burns a
    // delivery, so a cap above MAX_DELIVERIES could never be reached — the
    // channel dead-letters the message first and the loop then waits forever on
    // an empty queue, which looks exactly like an agent that answers nothing.
    const driver = drive(channel, fake, { onStop: (error) => stops.push(error) });

    channel.post({ role: "user", text: "anybody there?" });
    await until(() => stops.length === 1);

    // A CLI that cannot run at all is reported, not retried forever: without an
    // exit the pane would show a live agent that never answers again.
    expect(stops[0]).toContain("Invalid API key");
    expect(fake.calls()).toHaveLength(MAX_DELIVERIES);
    expect(channel.history().some((t) => t.role === "agent")).toBe(false);
    expect(channel.driven).toBe(false);
    // And the message is marked dropped, so the pane can say so too.
    expect(store.listDroppedUserSeqs()).toHaveLength(1);
    await driver.done;
  });

  it("gives up when the channel says the message can never come back", async () => {
    const fake = fakeCli([{ errors: ["Overloaded"] }]);
    const { store, channel } = make();
    const stops: Array<string | null> = [];
    // A cap deliberately above the delivery cap: the loop must still end. This
    // is the shape the give-up used to be unreachable in — the message
    // dead-letters at MAX_DELIVERIES and every later wait is on an empty queue.
    const driver = drive(channel, fake, {
      maxFailures: 50,
      onStop: (error) => stops.push(error),
    });

    channel.post({ role: "user", text: "anybody there?" });
    await until(() => stops.length === 1);

    expect(stops[0]).toContain("Overloaded");
    expect(fake.calls()).toHaveLength(MAX_DELIVERIES);
    expect(store.listDroppedUserSeqs()).toHaveLength(1);
    await driver.done;
  });

  it("reports a channel that threw instead of taking the process down with it", async () => {
    const fake = fakeCli([{ answer: "never asked" }]);
    const stops: Array<string | null> = [];
    // What shutdown looks like from inside the loop: app.ts closes the launcher,
    // the channel and the store in one tick, and a parked wait resumes against a
    // closed database. That rejection used to reach nothing — no catch anywhere
    // above it — and killed the whole Boxaide process a moment after onStop had
    // already recorded a clean stop.
    const driver = new ClaudeDriver({
      channel: {
        awaitUserTurn: () => Promise.reject(new Error("The database connection is not open")),
        answer: () => true,
        releaseLease: () => "missing",
        noteAgentActivity: () => {},
        setDriven: () => {},
        needsTitle: () => false,
        nameChat: () => false,
        chatSession: () => ({ id: null, epoch: 0 }),
        saveChatSession: () => {},
        clearChatSession: () => {},
      },
      agent: "claude-code",
      bin: process.execPath,
      argsFor: argsFor(fake.script),
      cwd: tmpdir(),
      env: fake.env,
      onStop: (error) => stops.push(error),
    }).start();

    await driver.done;
    expect(stops).toEqual(["The database connection is not open"]);
    // Nothing was prompted: the loop never got a message to work on.
    expect(fake.calls()).toEqual([]);
  });

  it("kills a turn that answers, keeps printing and ignores SIGTERM on Stop", async () => {
    const fake = fakeCli([{ answer: "still talking", deaf: true }]);
    const { channel } = make();
    const stops: Array<string | null> = [];
    // A long watchdog window on purpose: this child is never silent, so the
    // watchdog is not what saves the loop here.
    const driver = drive(channel, fake, {
      watchdogMs: 60_000,
      stopGraceMs: 100,
      onStop: (error) => stops.push(error),
    });

    const user = channel.post({ role: "user", text: "say something" });
    // Stop only once the answer line has provably reached the pipe. The child's
    // start is not enough: with a short grace the SIGKILL can otherwise land
    // before the result is written, and the test would be asserting on a race.
    await until(() => fake.answered());

    driver.stop();
    // Without the escalation this never resolves: the turn's child outlives
    // SIGTERM, the loop stays inside it, and `running` stays true — no exit, no
    // later start, until Boxaide itself is restarted.
    await driver.done;
    expect(stops).toEqual([null]);
    expect(channel.driven).toBe(false);
    // Killed after it had already answered, so the answer is not thrown away.
    const answer = channel.history().find((t) => t.role === "agent");
    expect(answer?.text).toBe("still talking");
    expect(answer?.replyTo).toBe(user.seq);
  });

  it("answers from a result event that arrived without its newline", async () => {
    // 300KB of answer, unterminated: past the presence reader's line cap and
    // with nothing to flush it but the end of the stream. Both are ways a
    // finished, paid-for turn used to score as "claude produced no answer".
    const fake = fakeCli([{ answer: "the long answer ", pad: 300_000, noNewline: true }]);
    const { store, channel } = make();
    const driver = drive(channel, fake);

    const user = channel.post({ role: "user", text: "write me an essay" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    const answer = channel.history().find((t) => t.role === "agent")!;
    expect(answer.text).toHaveLength(300_000);
    expect(answer.replyTo).toBe(user.seq);
    // Answered on the first attempt: no re-run, no burnt delivery.
    expect(userCalls(fake)).toHaveLength(1);
    expect(store.listDroppedUserSeqs()).toEqual([]);

    driver.stop();
    await driver.done;
  });

  it("gives each chat its own session, and resumes it after a restart", async () => {
    const fake = fakeCli([
      { session: "ses-a", answer: "chat one" },
      { session: "ses-b", answer: "chat two" },
      // No session of its own: whatever this call was told to resume.
      { answer: "back in one" },
    ]);
    const { channel } = make();
    const first = channel.activeChat().id;
    const second = channel.createChat().id;
    // Named by the user, so nothing asks the model for a title and every call
    // in the log is a turn.
    channel.renameChat(first, "First");
    channel.renameChat(second, "Second");
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "one", chatId: first });
    await until(() => channel.history(undefined, first).some((t) => t.role === "agent"));
    channel.post({ role: "user", text: "two", chatId: second });
    await until(() => channel.history(undefined, second).some((t) => t.role === "agent"));

    // Two chats, two fresh sessions: the second conversation does not open in
    // the middle of the first one's transcript.
    expect(fake.calls()[0]).not.toContain("--resume");
    expect(fake.calls()[1]).not.toContain("--resume");

    driver.stop();
    await driver.done;

    // A restart is not a new conversation. The ids are in the store and the
    // workdir the transcripts live in is the same one.
    const again = drive(channel, fake);
    channel.post({ role: "user", text: "still there?", chatId: first });
    await until(
      () => channel.history(undefined, first).filter((t) => t.role === "agent").length === 2,
    );

    const resumed = fake.calls()[2];
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("ses-a");
    expect(resumed[resumed.indexOf("-p") + 1]).toBe("still there?");

    again.stop();
    await again.done;
  });

  it("drops only the refused chat's session when a resume is refused", async () => {
    const fake = fakeCli([
      { session: "ses-a", answer: "chat one" },
      { session: "ses-b", answer: "chat two" },
      { errors: ["No conversation found with session ID: $RESUME"] },
      { session: "ses-a2", answer: "fresh start" },
      { answer: "chat two again" },
    ]);
    const { store, channel } = make();
    const first = channel.activeChat().id;
    const second = channel.createChat().id;
    channel.renameChat(first, "First");
    channel.renameChat(second, "Second");
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "one", chatId: first });
    await until(() => channel.history(undefined, first).some((t) => t.role === "agent"));
    channel.post({ role: "user", text: "two", chatId: second });
    await until(() => channel.history(undefined, second).some((t) => t.role === "agent"));

    channel.post({ role: "user", text: "one again", chatId: first });
    await until(
      () => channel.history(undefined, first).filter((t) => t.role === "agent").length === 2,
    );

    // The refused chat started over; the other chat's transcript was never in
    // question and is still what its next turn resumes.
    expect(store.chatSession(first, "claude-code").id).toBe("ses-a2");
    expect(store.chatSession(second, "claude-code").id).toBe("ses-b");

    channel.post({ role: "user", text: "two again", chatId: second });
    await until(
      () => channel.history(undefined, second).filter((t) => t.role === "agent").length === 2,
    );
    const onSecond = fake.calls()[4];
    expect(onSecond[onSecond.indexOf("--resume") + 1]).toBe("ses-b");
    expect(store.listDroppedUserSeqs()).toEqual([]);

    driver.stop();
    await driver.done;
  });

  it("repairs the credential once and answers the same message on the retry", async () => {
    // The observed failure, exactly: exit 0, subtype success, and the sign-out
    // notice sitting where the answer goes. Posted as an answer it reaches the
    // user as their agent telling them to run a command.
    const fake = fakeCli([
      { answer: "Not logged in · Please run /login" },
      { answer: "two invoices came in" },
    ]);
    const { store, channel } = make();
    let heals = 0;
    const driver = drive(channel, fake, {
      healAuth: () => {
        heals += 1;
        return true;
      },
    });

    const user = channel.post({ role: "user", text: "what came in today?" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    const answer = channel.history().find((t) => t.role === "agent")!;
    expect(answer.text).toBe("two invoices came in");
    expect(answer.replyTo).toBe(user.seq);
    // One repair, one extra process, and the notice never reached the pane.
    expect(heals).toBe(1);
    expect(userCalls(fake)).toHaveLength(2);
    expect(channel.history().some((t) => t.text.includes("/login"))).toBe(false);
    // And it cost no delivery: the retry happened inside the turn, so the lease
    // was never given back.
    expect(store.listDroppedUserSeqs()).toEqual([]);

    driver.stop();
    await driver.done;
  });

  it("does not put a cleared chat back on the session it was answering in", async () => {
    const fake = fakeCli([
      { session: "ses-a", answer: "the long answer", slow: true },
      { session: "ses-b", answer: "after the clear" },
    ]);
    const { store, channel } = make();
    const chat = channel.activeChat().id;
    channel.renameChat(chat, "Mine");
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "something long", chatId: chat });
    await until(() => fake.started());

    // The user empties the chat while the model is still working on it.
    channel.clear(chat);
    fake.release();
    await until(() => fake.calls().length === 1 && !channel.presence().working);

    // The answer landed on a session the chat no longer has, and saving it
    // would have handed the next message a transcript the user just emptied.
    expect(store.chatSession(chat, "claude-code").id).toBeNull();

    // The next message starts a session rather than resuming the emptied one.
    channel.post({ role: "user", text: "still empty?", chatId: chat });
    await until(() => fake.calls().length === 2);
    expect(fake.calls()[1]).not.toContain("--resume");
    await until(() => store.chatSession(chat, "claude-code").id !== null);
    expect(store.chatSession(chat, "claude-code").id).toBe("ses-b");

    driver.stop();
    await driver.done;
  });

  it("treats a result event with nothing in it as the same failure", async () => {
    // "claude: success" — a result the CLI called successful and put no text on.
    // Unusable whatever caused it, and what the signed-out run actually emitted.
    const fake = fakeCli([{ empty: true }, { answer: "back in business" }]);
    const { channel } = make();
    let heals = 0;
    const driver = drive(channel, fake, {
      healAuth: () => {
        heals += 1;
        return true;
      },
    });

    channel.post({ role: "user", text: "anything?" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    expect(heals).toBe(1);
    expect(channel.history().find((t) => t.role === "agent")!.text).toBe(
      "back in business",
    );

    driver.stop();
    await driver.done;
  });

  it("drops an answer to a question the user deleted while it was being written", async () => {
    const fake = fakeCli([
      { session: "ses-a", answer: "the long answer", slow: true },
      { session: "ses-b", answer: "second answer" },
    ]);
    const { store, channel } = make();
    const emptied = channel.activeChat().id;
    const other = channel.createChat().id;
    channel.renameChat(emptied, "Mine");
    channel.renameChat(other, "Elsewhere");
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "something long", chatId: emptied });
    await until(() => fake.started());

    // The user empties the chat and looks at another one while the model works.
    channel.clear(emptied);
    channel.selectChat(other);
    fake.release();

    // The loop takes one turn at a time, so the next answer landing proves the
    // first one was finished with — posted or dropped — before this ran.
    channel.post({ role: "user", text: "next", chatId: other });
    await until(() => channel.history(undefined, other).some((t) => t.role === "agent"));

    // The first answer went with the question the user deleted. It is not in
    // the chat it was asked in, and it did not land in the chat they moved to.
    expect(channel.history(undefined, emptied)).toEqual([]);
    expect(
      store
        .listTurns()
        .filter((t) => t.role === "agent")
        .map((t) => t.text),
    ).toEqual(["second answer"]);

    driver.stop();
    await driver.done;
  });

  it("repairs once per run, then reports the sign-out instead of retrying it", async () => {
    const fake = fakeCli([{ answer: "Not logged in · Please run /login" }]);
    const { store, channel } = make();
    let heals = 0;
    const stops: Array<{ error: string | null; authRequired: boolean }> = [];
    const driver = drive(channel, fake, {
      healAuth: () => {
        heals += 1;
        return true;
      },
      onStop: (error, cause) => stops.push({ error, ...cause }),
    });

    channel.post({ role: "user", text: "still there?" });
    await until(() => stops.length === 1);

    // Signed out after a fresh credential is a real sign-out. Repairing on
    // every later turn would spend the delivery budget re-copying a file that
    // is not the problem and then report the wrong reason.
    expect(heals).toBe(1);
    // MAX_DELIVERIES turns, and one extra process for the single repair.
    expect(userCalls(fake)).toHaveLength(MAX_DELIVERIES + 1);
    expect(stops[0].error).toContain("not signed in");
    // The one thing the pane cannot get by reading that sentence.
    expect(stops[0].authRequired).toBe(true);
    // Nothing was posted as an answer, and the message is marked dropped.
    expect(channel.history().some((t) => t.role === "agent")).toBe(false);
    expect(store.listDroppedUserSeqs()).toHaveLength(1);
    await driver.done;
  });

  it("does not spend a turn on a repair that changed nothing", async () => {
    const fake = fakeCli([{ answer: "Invalid API key · Please run /login" }]);
    const { channel } = make();
    const stops: Array<{ error: string | null; authRequired: boolean }> = [];
    // No credential file to drop and none to copy: the launcher is saying a
    // retry would meet the identical credential.
    const driver = drive(channel, fake, {
      healAuth: () => false,
      onStop: (error, cause) => stops.push({ error, ...cause }),
    });

    channel.post({ role: "user", text: "still there?" });
    await until(() => stops.length === 1);

    expect(userCalls(fake)).toHaveLength(MAX_DELIVERIES);
    expect(stops[0].error).toContain("Invalid API key");
    expect(stops[0].authRequired).toBe(true);
    await driver.done;
  });

  it("reports a stop as a stop, whatever the last turn was", async () => {
    const fake = fakeCli([{ answer: "never asked" }]);
    const { channel } = make();
    const stops: Array<{ error: string | null; authRequired: boolean }> = [];
    const driver = drive(channel, fake, {
      waitMs: 100_000,
      onStop: (error, cause) => stops.push({ error, ...cause }),
    });

    await until(() => channel.presence().waiting === 1);
    driver.stop();
    await driver.done;
    // A pane that offered a sign-in here would be offering it for an agent the
    // user simply switched off.
    expect(stops).toEqual([{ error: null, authRequired: false }]);
  });

  it("names the chat from the exchange, once, and never at the answer's expense", async () => {
    const fake = fakeCli([
      { answer: "two invoices" },
      { errors: ["Overloaded"] },
      { answer: "Invoices from today" },
    ]);
    const { channel } = make();
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "what came in today?" });
    await until(() => channel.history().some((t) => t.role === "agent"));
    await until(() => fake.calls().some(isNaming));
    // A failed naming is not a failed turn: the answer stands and the message
    // is not re-queued.
    expect(channel.history().filter((t) => t.role === "agent")).toHaveLength(1);
    expect(channel.chats()[0].title).toBe("what came in today?");

    channel.post({ role: "user", text: "and yesterday?" });
    await until(() => channel.chats()[0].title === "Invoices from today");
    expect(fake.calls().filter(isNaming)).toHaveLength(2);

    channel.post({ role: "user", text: "and the day before?" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 3);
    expect(fake.calls().filter(isNaming)).toHaveLength(2);

    driver.stop();
    await driver.done;
  });
});

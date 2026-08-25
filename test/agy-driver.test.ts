/**
 * The in-process Antigravity loop, tested the way it runs: a real AgentChannel
 * over a real (in-memory) store, and real child processes standing in for
 * `agy -p`. Nothing here is mocked except the CLI itself, the stand-in is a
 * node script that prints the stream-json shapes the real one prints, so the
 * spawn, the pipes, the exit codes and the SIGKILL are all genuine.
 *
 * The shapes it prints were captured by running agy on this machine. The raw
 * captures are in the scratchpad this was written from, agy-probe-1.jsonl
 * (a plain turn), agy-probe-2.jsonl (the same conversation resumed with
 * --conversation), agy-probe-3-tools.jsonl (tool steps, and a turn that
 * answered in full while still reporting status ERROR), agy-probe-4-badresume
 * (an unknown --conversation: a warning on stderr and a NEW conversation), and
 * agy-probe-5-timeout.jsonl (--print-timeout expiring):
 *
 *   {"event":"init","conversation_id":"<uuid>","init":{"model":…,"tools":[…]}}
 *   {"event":"step_update","step_update":{"conversation_id":"<uuid>",
 *     "step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"list_dir",
 *     "tool_info":{…}}}
 *   {"event":"result","result":{"conversation_id":"<uuid>","status":"SUCCESS",
 *     "response":"OK\n","duration_seconds":4.9,"num_turns":1,"usage":{…}}}
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgyLine, type StreamTurnOutcome } from "../src/agent/agent-stream.js";
import { AgentChannel } from "../src/agent/channel.js";
import { AgyDriver } from "../src/agent/agy-driver.js";
import { ANTIGRAVITY_SPEC, antigravityTurnArgs } from "../src/agent/clis/antigravity.js";
import { DRIVEN_SYSTEM } from "../src/agent/driver.js";
import { AgentLauncher } from "../src/agent/launcher.js";
import { Store } from "../src/db/store.js";

/**
 * One scripted invocation. Entries are consumed in order and the last one
 * repeats, so a single-entry script is a CLI that always behaves that way.
 */
type Step = {
  /** The conversation id every line of this invocation reports. */
  conversation?: string;
  /** Tool names to announce, as an ACTIVE step followed by a DONE one. */
  tools?: string[];
  /** The answer, as the result event's `response`. */
  answer?: string;
  /** The result event's `status`. Defaults to SUCCESS. */
  status?: string;
  /** The result event's `error`, which agy writes beside `response`. */
  error?: string;
  /** Print the init line and then never exit: the case the watchdog is for. */
  hang?: boolean;
  /** Never stop narrating and never finish: the case the deadline is for. */
  chatty?: boolean;
  /**
   * Announce the turn, then hold it until the test releases it. What a long
   * answer looks like from outside: the test gets to act on the chat while the
   * model is demonstrably still working on it.
   */
  slow?: boolean;
};

/**
 * The fake CLI. Reads its script from a file rather than argv, because the
 * driver owns the command line and only the launcher decides what is on it.
 */
const FAKE_CLI = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + "\\n");
// Counted over the user's turns only. The driver also spawns a naming call
// after an answer, and a script whose steps were consumed by those would be one
// entry out of step with the conversation the test is reading.
const calls = fs
  .readFileSync(process.env.FAKE_LOG, "utf8")
  .trim()
  .split("\\n")
  .filter((line) => !line.includes("Name this conversation")).length;
const steps = JSON.parse(fs.readFileSync(process.env.FAKE_SCRIPT, "utf8"));
const step = steps[Math.min(Math.max(calls, 1) - 1, steps.length - 1)];
const at = argv.indexOf("--conversation");
const resume = at >= 0 ? argv[at + 1] : null;
// agy reports the conversation it actually ran in, which is the resumed one
// unless the script says otherwise, the way it answers an id it cannot find.
const id = step.conversation || resume || "agy-fresh";
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const stepUpdate = (fields) =>
  say({ event: "step_update", step_update: { conversation_id: id, ...fields } });
say({ event: "init", conversation_id: id, init: { model: "m", cwd: process.cwd(), tools: [] } });
stepUpdate({ step_index: 0, state: "DONE", step_type: "user_input" });
let index = 1;
for (const tool of step.tools || []) {
  stepUpdate({ step_index: index, state: "ACTIVE", step_type: "tool", tool_name: tool });
  stepUpdate({ step_index: index, state: "DONE", step_type: "tool", tool_name: tool });
  index += 1;
}
const result = () => {
  const body = {
    conversation_id: id,
    status: step.status || "SUCCESS",
    response: step.answer === undefined ? "" : step.answer,
    duration_seconds: 0,
    num_turns: 1,
  };
  if (step.error) body.error = step.error;
  say({ event: "result", result: body });
};
if (step.hang) {
  // Alive, silent, and holding the turn: a live process with a dead turn behind
  // it, which elapsed time alone cannot tell from a slow one.
  setInterval(() => {}, 1000);
} else if (step.chatty) {
  // The opposite failure: never silent, never finished. The watchdog reads this
  // as a healthy turn, so only the absolute deadline ends it.
  setInterval(
    () => stepUpdate({ step_index: index++, state: "DONE", step_type: "agent_response", text_delta: "still going " }),
    20,
  );
} else if (step.slow) {
  // Says it started, then waits to be let go. The turn is genuinely in flight
  // for as long as the test wants it to be.
  fs.writeFileSync(process.env.FAKE_STARTED, "");
  const tick = setInterval(() => {
    if (!fs.existsSync(process.env.FAKE_RELEASE)) return;
    clearInterval(tick);
    result();
    process.exit(0);
  }, 10);
} else {
  result();
  // agy exits 1 when its own print timeout ended the turn, and 0 otherwise.
  process.exit(step.status === "SUCCESS" || !step.status ? 0 : 1);
}
`;

type Fake = {
  /** The script to pass as the driver's first argv element. */
  script: string;
  env: NodeJS.ProcessEnv;
  /** argv of every invocation, in order. */
  calls: () => string[][];
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
  const dir = mkdtempSync(join(tmpdir(), "boxaide-agy-driver-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "fake-agy.cjs");
  const log = join(dir, "calls.ndjson");
  writeFileSync(script, FAKE_CLI);
  writeFileSync(join(dir, "steps.json"), JSON.stringify(steps));
  const started = join(dir, "started");
  const release = join(dir, "release");
  return {
    script,
    env: {
      ...process.env,
      FAKE_LOG: log,
      FAKE_SCRIPT: join(dir, "steps.json"),
      FAKE_STARTED: started,
      FAKE_RELEASE: release,
    },
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
 * The argv the driver is given for a turn: the real builder, minus the launch's
 * own sandbox prefix. Unlike the Claude suite this uses the production one,
 * because how the framing reaches agy IS the command line, there is no
 * system-prompt flag to check separately.
 */
function argsFor(script: string, dataDir: string) {
  return (turn: { prompt: string; system: string; sessionId: string | null }) => [
    script,
    ...antigravityTurnArgs(
      { mcpUrl: "http://127.0.0.1:0/mcp", bearerToken: "t", dataDir },
      turn,
    ),
  ];
}

function drive(
  channel: AgentChannel,
  fake: Fake,
  over: Partial<{
    waitMs: number;
    retryBaseMs: number;
    watchdogMs: number;
    turnTimeoutMs: number;
    maxFailures: number;
    stopGraceMs: number;
    memorySystem: () => string;
    onStop: (error: string | null, cause: { authRequired: boolean }) => void;
  }> = {},
): AgyDriver {
  const dataDir = mkdtempSync(join(tmpdir(), "boxaide-agy-data-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const driver = new AgyDriver({
    channel,
    agent: "antigravity",
    bin: process.execPath,
    argsFor: argsFor(fake.script, dataDir),
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
  return argv.some((arg) => arg.includes("Name this conversation"));
}

function userCalls(fake: Fake): string[][] {
  return fake.calls().filter((argv) => !isNaming(argv));
}

/** The prompt one invocation was given: the framing and the message, joined. */
function promptOf(argv: string[]): string {
  return argv[argv.indexOf("-p") + 1]!;
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function outcome(): StreamTurnOutcome {
  return { text: null, sessionId: null, error: null };
}

describe("readAgyLine", () => {
  it("takes the conversation id off the init line, verbatim from a capture", () => {
    const found = outcome();
    // agy-probe-1.jsonl line 1, with the 55-entry tools array elided.
    expect(
      readAgyLine(
        '{"event":"init","conversation_id":"da47d09e-7617-43dd-b105-3556e1d6f1e1","init":{"model":"gemini-3.7-flash-medium","cwd":"/tmp","tools":["list_dir"],"permission_mode":"always-proceed"}}',
        found,
      ),
    ).toBeNull();
    expect(found.sessionId).toBe("da47d09e-7617-43dd-b105-3556e1d6f1e1");
  });

  it("names the tool an ACTIVE step started, and nothing when it finishes", () => {
    // agy-probe-3-tools.jsonl, the ACTIVE/DONE pair for one list_dir call.
    const active =
      '{"event":"step_update","step_update":{"conversation_id":"a82c4a3f-133c-431e-bfbc-3eb6d7a8166d","step_index":5,"state":"ACTIVE","step_type":"tool","tool_name":"list_dir","tool_info":{"name":"list_dir","parameters":{"DirectoryPath":"/tmp"}}}}';
    const done =
      '{"event":"step_update","step_update":{"conversation_id":"a82c4a3f-133c-431e-bfbc-3eb6d7a8166d","step_index":5,"state":"DONE","step_type":"tool","tool_name":"list_dir","duration_seconds":0.013865}}';
    expect(readAgyLine(active, outcome())).toBe("list_dir");
    expect(readAgyLine(done, outcome())).toBeNull();
  });

  it("strips the Boxaide prefix a CLI puts on an MCP tool", () => {
    expect(
      readAgyLine(
        '{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"tool","tool_name":"boxaide__messages_list"}}',
        outcome(),
      ),
    ).toBe("messages_list");
  });

  it("says nothing about the steps that are not tools", () => {
    for (const line of [
      '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
      '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"checkpoint","duration_seconds":1.7}}',
      '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"OK\\n"}}',
    ]) {
      expect(readAgyLine(line, outcome())).toBeNull();
    }
  });

  it("survives a line that is not JSON at all", () => {
    expect(readAgyLine("Fetching available models...", outcome())).toBeNull();
    expect(readAgyLine("{ truncated", outcome())).toBeNull();
  });

  it("reads the answer off the result event, verbatim from a capture", () => {
    const found = outcome();
    readAgyLine(
      '{"event":"result","result":{"conversation_id":"da47d09e-7617-43dd-b105-3556e1d6f1e1","status":"SUCCESS","response":"OK\\n","duration_seconds":4.90243,"num_turns":1,"usage":{"total_tokens":19767}}}',
      found,
    );
    expect(found.text).toBe("OK");
    expect(found.error).toBeNull();
    expect(found.sessionId).toBe("da47d09e-7617-43dd-b105-3556e1d6f1e1");
  });

  /**
   * The reading this whole parser turns on. agy reported ERROR for a tool call
   * the model then worked around, and still answered the question in full.
   * Scoring that as a failure would re-run a finished turn and eventually
   * dead-letter the user's message.
   */
  it("keeps the answer when status is ERROR and a response came with it", () => {
    const found = outcome();
    readAgyLine(
      '{"event":"result","result":{"conversation_id":"a82c4a3f-133c-431e-bfbc-3eb6d7a8166d","status":"ERROR","response":"The directory is empty.","error":"permission check failed for read_file","duration_seconds":10.7,"num_turns":1}}',
      found,
    );
    expect(found.text).toBe("The directory is empty.");
    expect(found.error).toBeNull();
  });

  it("reports agy's own reason when the result carries no response", () => {
    const found = outcome();
    // agy-probe-5-timeout.jsonl, the last line of a run that exited 1 with
    // nothing on stderr.
    readAgyLine(
      '{"event":"result","result":{"conversation_id":"a23ab6a6-ae32-4b6d-b90f-91d0e506ff66","status":"ERROR","response":"","error":"timeout waiting for response","duration_seconds":0,"num_turns":1}}',
      found,
    );
    expect(found.text).toBeNull();
    expect(found.error).toBe("timeout waiting for response");
  });

  it("names the status when a failed result explained nothing", () => {
    const found = outcome();
    readAgyLine('{"event":"result","result":{"status":"CANCELLED","response":""}}', found);
    expect(found.error).toBe("agy: CANCELLED");
  });

  it("leaves an empty success for the driver to call no answer", () => {
    const found = outcome();
    readAgyLine('{"event":"result","result":{"status":"SUCCESS","response":""}}', found);
    expect(found.text).toBeNull();
    expect(found.error).toBeNull();
  });
});

describe("AgyDriver", () => {
  it("marks an OAuth failure as requiring sign-in", async () => {
    const fake = fakeCli([{ status: "ERROR", error: "authentication failed or timed out" }]);
    const { channel } = make();
    const stops: Array<{ error: string | null; authRequired: boolean }> = [];
    const driver = drive(channel, fake, {
      maxFailures: 1,
      onStop: (error, cause) => stops.push({ error, authRequired: cause.authRequired }),
    });

    channel.post({ role: "user", text: "read everything" });
    await driver.done;

    expect(stops).toHaveLength(1);
    expect(stops[0]?.authRequired).toBe(true);
    expect(stops[0]?.error).toMatch(/antigravity is not signed in/i);
  });

  it("answers a user turn from the result event and carries the conversation forward", async () => {
    const fake = fakeCli([
      { conversation: "conv-1", answer: "two invoices came in" },
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
    expect(answer.agent).toBe("antigravity");
    // The lease ended with the answer.
    expect(channel.presence().working).toBeNull();

    const opened = userCalls(fake)[0]!;
    // agy has no --append-system-prompt, so the framing is the head of the
    // prompt and the user's message is the tail.
    expect(promptOf(opened)).toBe(`${DRIVEN_SYSTEM}\n\n---\n\nwhat came in today?`);
    expect(opened).toContain("--output-format");
    expect(opened).toContain("stream-json");
    // Left at its default this is 5 minutes, which is what killed the launch
    // this driver replaces.
    expect(opened[opened.indexOf("--print-timeout") + 1]).toBe("900s");
    // Nothing to resume on the first turn of a conversation.
    expect(opened).not.toContain("--conversation");

    const second = channel.post({ role: "user", text: "anything else?" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 2);

    const followUp = channel.history().filter((t) => t.role === "agent")[1]!;
    expect(followUp.text).toBe("and one reply");
    expect(followUp.replyTo).toBe(second.seq);
    // The whole point of the second process: it continues the first one's
    // conversation instead of meeting the user for the first time.
    const resumed = userCalls(fake)[1]!;
    expect(resumed[resumed.indexOf("--conversation") + 1]).toBe("conv-1");

    driver.stop();
    await driver.done;
  });

  it("appends the workspace-memory block to the framing of every turn", async () => {
    const fake = fakeCli([{ answer: "noted" }]);
    const { channel } = make();
    const driver = drive(channel, fake, { memorySystem: () => "MEMORY BLOCK" });

    channel.post({ role: "user", text: "what came in today?" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    expect(promptOf(userCalls(fake)[0]!)).toBe(
      `${DRIVEN_SYSTEM}\n\nMEMORY BLOCK\n\n---\n\nwhat came in today?`,
    );

    driver.stop();
    await driver.done;
  });

  /**
   * agy answers a --conversation it cannot find with a warning on stderr and a
   * brand new conversation, verified, agy-probe-4-badresume. So there is
   * nothing to detect: the id the run reports is already the new one, and the
   * next turn has to resume THAT, not the id that was refused.
   */
  it("remembers the conversation agy actually ran in, not the one it was asked for", async () => {
    const fake = fakeCli([
      { conversation: "conv-old", answer: "first" },
      // The rotation: agy ignores the id it was handed and reports its own.
      { conversation: "conv-new", answer: "second" },
      { answer: "third" },
    ]);
    const { channel } = make();
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "one" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 1);
    channel.post({ role: "user", text: "two" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 2);
    channel.post({ role: "user", text: "three" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 3);

    const calls = userCalls(fake);
    expect(calls[1]![calls[1]!.indexOf("--conversation") + 1]).toBe("conv-old");
    // The turn that rotated is the one that decides what the next turn resumes.
    expect(calls[2]![calls[2]!.indexOf("--conversation") + 1]).toBe("conv-new");

    driver.stop();
    await driver.done;
  });

  it("keeps a turn that answered in full while reporting an error", async () => {
    const fake = fakeCli([
      {
        answer: "The mailbox is empty.",
        status: "ERROR",
        error: "permission check failed for read_file",
      },
    ]);
    const { channel } = make();
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "anything in there?" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    expect(channel.history().find((t) => t.role === "agent")!.text).toBe(
      "The mailbox is empty.",
    );
    // One process. A turn scored as failed would have been run again.
    expect(userCalls(fake)).toHaveLength(1);

    driver.stop();
    await driver.done;
  });

  it("fails the turn, visibly, when agy's own print timeout ends it", async () => {
    const fake = fakeCli([
      { status: "ERROR", error: "timeout waiting for response" },
      { answer: "second time lucky" },
    ]);
    const { channel } = make();
    const driver = drive(channel, fake);

    channel.post({ role: "user", text: "read everything" });
    // The failed turn gives the lease back, so the message is handed over again
    // rather than left hanging on a pane that says "Waiting for an agent".
    await until(() => channel.history().some((t) => t.role === "agent"));
    expect(channel.history().find((t) => t.role === "agent")!.text).toBe(
      "second time lucky",
    );
    expect(userCalls(fake).length).toBeGreaterThanOrEqual(2);

    driver.stop();
    await driver.done;
  });

  it("kills a turn that goes silent, and hands the message back", async () => {
    const fake = fakeCli([
      { tools: ["run_command"], hang: true },
      { answer: "back on its feet" },
    ]);
    const { channel } = make();
    const driver = drive(channel, fake, { watchdogMs: 200, retryBaseMs: 50 });

    channel.post({ role: "user", text: "read everything" });
    await until(() => channel.history().some((t) => t.role === "agent"), 20_000);

    expect(channel.history().find((t) => t.role === "agent")!.text).toBe(
      "back on its feet",
    );
    expect(userCalls(fake).length).toBeGreaterThanOrEqual(2);

    driver.stop();
    await driver.done;
  });

  /**
   * The failure silence cannot see. This child narrates every 20ms forever, so
   * the watchdog reads a healthy turn for as long as it runs; only the absolute
   * deadline ends it, and without one the lease would be held until Boxaide
   * itself restarted.
   */
  it("kills a turn that never stops talking and never finishes", async () => {
    const fake = fakeCli([{ chatty: true }, { answer: "and now an answer" }]);
    const { channel } = make();
    const reasons: string[] = [];
    const driver = drive(channel, fake, {
      // Long enough that a turn narrating every 20ms is never quiet.
      watchdogMs: 30_000,
      turnTimeoutMs: 1_000,
      retryBaseMs: 50,
      maxFailures: 1,
      onStop: (error) => {
        if (error) reasons.push(error);
      },
    });

    channel.post({ role: "user", text: "read everything" });
    await driver.done;

    expect(reasons).toEqual(["agy ran for 1s without finishing and was stopped"]);
  });

  /**
   * What POST /api/agent/stop does, in the order it does it: the channel closes
   * the question first (`cancelWork`), then the launcher reaches the driver
   * (`launcher.interrupt` → this). Closing first is what makes it a stop rather
   * than a restart, a lease given back to a live loop would be handed straight
   * to the agent that was just killed.
   */
  it("kills the running agy child on Stop, and stays up for the next message", async () => {
    const fake = fakeCli([
      { slow: true, answer: "never posted" },
      { answer: "the next one" },
    ]);
    const { channel } = make();
    const driver = drive(channel, fake);

    const question = channel.post({ role: "user", text: "read everything" });
    await until(() => fake.started());
    expect(channel.presence().working?.seq).toBe(question.seq);

    expect(channel.cancelWork(question.seq)?.seq).toBe(question.seq);
    expect(driver.interrupt(question.seq)).toBe(true);

    // The child really died: it was told to hold the turn until released, and
    // it is never released here.
    await until(() => channel.presence().working === null);
    const stopped = channel.history().find((t) => t.role === "agent")!;
    expect(stopped.text).toBe("Stopped.");
    expect(stopped.replyTo).toBe(question.seq);

    // Still driving. The agent stays up: that is the difference between Stop
    // and shutdown.
    const next = channel.post({ role: "user", text: "and now this" });
    await until(() => channel.history().some((t) => t.text === "the next one"));
    expect(channel.history().find((t) => t.text === "the next one")!.replyTo).toBe(
      next.seq,
    );
    // The killed turn never posted its answer.
    expect(channel.history().some((t) => t.text === "never posted")).toBe(false);

    driver.stop();
    await driver.done;
  });

  it("refuses to ask a question Stop already closed", async () => {
    const fake = fakeCli([{ slow: true, answer: "never posted" }]);
    const { channel } = make();
    const driver = drive(channel, fake);

    const question = channel.post({ role: "user", text: "read everything" });
    await until(() => fake.started());
    channel.cancelWork(question.seq);
    driver.interrupt(question.seq);
    await until(() => channel.presence().working === null);

    const spawned = userCalls(fake).length;
    // Give the loop room to re-take it if it were going to.
    await new Promise((r) => setTimeout(r, 300));
    expect(userCalls(fake).length).toBe(spawned);

    driver.stop();
    await driver.done;
  });
});

/**
 * The other half of Stop: the route reaches the driver through the launcher,
 * and only a launch that really wired one has anything to reach.
 *
 * Started through AgentLauncher with the real ANTIGRAVITY_SPEC, so what is
 * under test is the spec's own `drive`, the wiring that decides whether Stop
 * kills an agy turn or does nothing at all. The HTTP handler above it does two
 * things (`channel.cancelWork`, then `launcher.interrupt`) and both are made
 * here in that order; the handler itself is covered in test/agent-channel.test.ts.
 */
describe("Antigravity through the launcher", () => {
  it("kills the running agy turn when Stop reaches the launcher", async () => {
    const fake = fakeCli([{ slow: true, answer: "never posted" }]);
    const { channel } = make();

    // A real `agy` on a PATH that holds nothing else, which is how the launcher
    // resolves the binary it spawns.
    const bin = mkdtempSync(join(tmpdir(), "boxaide-agy-bin-"));
    cleanup.push(() => rmSync(bin, { recursive: true, force: true }));
    const agy = join(bin, "agy");
    writeFileSync(agy, `#!/bin/sh\nexec ${process.execPath} ${fake.script} "$@"\n`);
    chmodSync(agy, 0o755);

    // An empty home, so the preflight reads no agy MCP config of the user's and
    // this suite does not depend on the machine it runs on.
    const home = mkdtempSync(join(tmpdir(), "boxaide-agy-home-"));
    mkdirSync(join(home, ".gemini"), { recursive: true });
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const dataDir = mkdtempSync(join(tmpdir(), "boxaide-agy-launch-"));
    cleanup.push(() => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(`${dataDir}-agents`, { recursive: true, force: true });
    });

    const launcher = new AgentLauncher(
      {
        mcpUrl: "http://127.0.0.1:0/mcp",
        bearerToken: "t",
        dataDir,
        // "full" so this describes launching, not confining. Confinement has
        // its own file, test/agent-sandbox.test.ts.
        access: "full",
        channel,
      },
      [ANTIGRAVITY_SPEC],
      { ...fake.env, PATH: bin, HOME: home },
      [],
    );
    cleanup.push(() => launcher.close());

    const running = await launcher.start("antigravity");
    // A driven-only launch has no one process to name: the loop is in this one.
    expect(running.pid).toBe(-1);

    const question = channel.post({ role: "user", text: "read everything" });
    await until(() => fake.started());
    expect(channel.presence().working?.seq).toBe(question.seq);

    // Exactly what POST /api/agent/stop does, in its order.
    const work = channel.cancelWork(question.seq);
    expect(work?.seq).toBe(question.seq);
    expect(launcher.interrupt(work!.seq)).toBe(true);

    await until(() => channel.presence().working === null);
    expect(channel.history().at(-1)!.text).toBe("Stopped.");
    // The turn that was killed never answered, and the agent is still up.
    expect(channel.history().some((t) => t.text === "never posted")).toBe(false);
    expect(launcher.status().running?.id).toBe("antigravity");
  });
});

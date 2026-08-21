/**
 * The two live Revelar automations, end to end: real scheduler, real platform,
 * real MCP protocol path, fixture mailbox.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. The agent is scripted, not a model:
 * each test supplies the exact tool calls the automation's prompt asks for.
 * That proves the platform underneath — the scheduler serializes, the tools
 * dispatch, the state comes out right, a run that dies halfway cannot cause a
 * second send. It does NOT prove that a language model reads the prompt and
 * chooses those calls, and it does not touch a real mail server. Judgement and
 * delivery still need a live run.
 *
 * Every tool call goes through handleMcpJsonRpc, the same entry point the
 * agent's MCP client uses, so a tool that is missing from the surface or wired
 * wrongly fails here rather than at 07:00 on Monday.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { createPlatform, type Platform } from "../src/platform.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";
import type { AgentLauncher, OneShotResult } from "../src/agent/launcher.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const CREDS = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "you@work.test", pass: "ok" },
};

/** The scripted agent: what the prompt would have made a model do. */
type AgentScript = (call: ToolCall) => Promise<void>;
type ToolCall = (name: string, args?: Record<string, unknown>) => Promise<any>;

async function harness(script: AgentScript) {
  const masterKey = randomBytes(32);
  const store = new Store(masterKey, ":memory:");
  cleanups.push(() => store.close());
  const provider = new FixtureProvider();
  const mail = new MailService(store, provider);
  const account = await mail.connectAccount({
    alias: "work",
    email: "you@work.test",
    creds: CREDS,
  });

  const runs: Array<{ prompt: string; result: OneShotResult }> = [];
  let platform: Platform;

  /**
   * Stands in for the agent CLI. Runs the script against the real JSON-RPC
   * surface and reports ok/error exactly as a real one-shot run would, so the
   * scheduler's own bookkeeping is exercised rather than bypassed.
   */
  const call: ToolCall = async (name, args = {}) => {
    const res = (await handleMcpJsonRpc(
      mail,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      undefined,
      platform,
    )) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
    const text = res?.result?.content?.[0]?.text ?? "null";
    if (res?.result?.isError) throw new Error(text);
    return JSON.parse(text);
  };

  const launcher = {
    runCapacity: () => 1,
    runLimit: () => 1,
    killRun: () => {},
    runOnce: async (opts: { prompt: string }): Promise<OneShotResult> => {
      let result: OneShotResult;
      try {
        await script(call);
        result = { status: "ok", exitCode: 0, log: "done" };
      } catch (err) {
        result = {
          status: "error",
          exitCode: 1,
          log: err instanceof Error ? err.message : String(err),
        };
      }
      runs.push({ prompt: opts.prompt, result });
      return result;
    },
  } as unknown as AgentLauncher;

  platform = createPlatform({ db: store.db, masterKey, mail, launcher });
  cleanups.push(() => platform.stop());
  return { store, provider, mail, account, platform, runs };
}

type H = Awaited<ReturnType<typeof harness>>;

/**
 * Creates the automation already due, then drains the queue once.
 *
 * The live pair are weekly ("0 7 * * 1"), which would put the next run days
 * out and never fire inside a test. A minute cron created in the past leaves
 * next_run_at behind us, which is the same condition the scheduler acts on.
 */
async function runAutomation(h: H, name: string, prompt: string) {
  const automation = h.platform.automationStore.create({
    name,
    cron: "* * * * *",
    prompt,
    now: new Date(Date.now() - 120_000),
  });
  await h.platform.scheduler.tick(new Date());
  // tick() starts runs and returns; these tests assert on finished ones.
  await h.platform.scheduler.idle();
  return automation;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const OUTREACH_PROMPT =
  "Pick up to 5 prospects who may be contacted, and queue one mail each for approval.";
const TRIAGE_PROMPT = "Read every reply since yesterday and log what came back.";

describe("Monday outreach automation", () => {
  /**
   * The selection step, against a CRM holding one of every awkward case,
   * including the five contacts whose contradictory tags started this.
   */
  async function seedProspects(h: H) {
    const crm = h.platform.crmStore;
    const fresh = crm.upsertContact({ email: "fresh@one.test" });
    const tagged = crm.upsertContact({ email: "tagged@two.test" });
    // Exactly the broken record from the live CRM.
    crm.addTags(tagged.id, ["queued", "contacted", "replied"]);
    const mailedYesterday = crm.upsertContact({ email: "recent@three.test" });
    crm.addInteraction({
      contactId: mailedYesterday.id,
      accountId: h.account.id,
      messageId: "m-1",
      direction: "out",
      at: daysAgo(1),
    });
    const optedOut = crm.upsertContact({ email: "stop@four.test" });
    h.platform.outreachStore.addSuppression(optedOut.email, "reply-stop");
    const answered = crm.upsertContact({ email: "talking@five.test" });
    crm.addInteraction({
      contactId: answered.id,
      accountId: h.account.id,
      messageId: "m-2",
      direction: "out",
      at: daysAgo(9),
    });
    crm.addInteraction({
      contactId: answered.id,
      accountId: h.account.id,
      messageId: "m-3",
      direction: "in",
      at: daysAgo(8),
    });
    return { fresh, tagged, mailedYesterday, optedOut, answered };
  }

  /** The prompt's actual steps: choose, then queue one draft each. */
  const outreachScript: AgentScript = async (call) => {
    const { states } = await call("crm_outreach_state", {
      contactableOnly: true,
      limit: 5,
    });
    for (const state of states) {
      await call("outbox_queue_draft", {
        account: "work",
        to: state.email,
        subject: "Quick question",
        body: "Hello there.",
        contactId: state.contactId,
      });
    }
  };

  it("queues only the people it is allowed to contact", async () => {
    const h = await harness(outreachScript);
    const people = await seedProspects(h);
    await runAutomation(h, "Outreach", OUTREACH_PROMPT);

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].result.status).toBe("ok");

    const queued = h.platform.outreachStore.listOutbox({ status: "pending" });
    const addressed = queued.map((row) => row.to).sort();
    expect(addressed).toEqual(["fresh@one.test", "tagged@two.test"]);

    // Named for the record: the contradictory tags no longer skip anyone, and
    // none of the three blocked cases slipped through.
    expect(addressed).toContain(people.tagged.email);
    expect(addressed).not.toContain(people.optedOut.email);
    expect(addressed).not.toContain(people.answered.email);
    expect(addressed).not.toContain(people.mailedYesterday.email);
  });

  it("does not queue the same person twice when it runs again", async () => {
    const h = await harness(outreachScript);
    await seedProspects(h);

    await runAutomation(h, "Outreach", OUTREACH_PROMPT);
    await runAutomation(h, "Outreach second", OUTREACH_PROMPT);

    expect(h.runs).toHaveLength(2);
    expect(h.runs.every((r) => r.result.status === "ok")).toBe(true);
    // Two runs, still one mail per person: the pending row blocks the reselect.
    expect(h.platform.outreachStore.listOutbox({}).length).toBe(2);
  });

  it("cannot double-send after a run dies between the send and the record", async () => {
    // The 15-minute limit, reproduced. The old design lost the `contacted` tag
    // here and mailed the person again on the next run.
    const sent: string[] = [];
    const h = await harness(async (call) => {
      const { states } = await call("crm_outreach_state", {
        contactableOnly: true,
        limit: 5,
      });
      for (const state of states) {
        const { queued } = await call("outbox_queue_draft", {
          account: "work",
          to: state.email,
          subject: "Quick question",
          body: "Hello there.",
          contactId: state.contactId,
        });
        // The human approves and the engine sends — then the run is cut off
        // before it can write anything else down.
        h.platform.outreachStore.decide(queued.id, "approved");
        h.platform.outreachStore.markSent(queued.id, new Date().toISOString());
        sent.push(state.email);
        throw new Error("run exceeded its time limit");
      }
    });

    const crm = h.platform.crmStore;
    crm.upsertContact({ email: "victim@one.test" });

    await runAutomation(h, "Outreach", OUTREACH_PROMPT);
    expect(h.runs[0].result.status).toBe("error");
    expect(sent).toEqual(["victim@one.test"]);

    // The failure is recorded rather than swallowed.
    const [firstRun] = h.platform.automationStore.listRuns(
      h.platform.automationStore.list()[0].id,
    );
    expect(firstRun.status).toBe("error");

    await runAutomation(h, "Outreach second", OUTREACH_PROMPT);
    expect(sent).toEqual(["victim@one.test"]);
  });

  it("runs a schedule it slept through, once, on the next tick", async () => {
    // The closed-laptop case: due at 07:00, opened at 09:00.
    const h = await harness(outreachScript);
    await seedProspects(h);
    const automation = h.platform.automationStore.create({
      name: "Outreach",
      cron: "* * * * *",
      prompt: OUTREACH_PROMPT,
      now: new Date(Date.now() - 2 * 3600_000),
    });

    await h.platform.scheduler.tick(new Date());
    await h.platform.scheduler.idle();
    expect(h.runs).toHaveLength(1);

    // And not again on the following tick: the run moved the schedule forward.
    await h.platform.scheduler.tick(new Date());
    await h.platform.scheduler.idle();
    await h.platform.scheduler.idle();
    expect(h.runs).toHaveLength(1);
    expect(h.platform.automationStore.get(automation.id)?.lastRunAt).not.toBe(null);
  });
});

describe("Reply triage automation", () => {
  /** Forty replies inside the window — more than one unfiltered page. */
  function seedBusyDay(h: H) {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      subject: `Re: proposal ${i}`,
      from: `person${i} <person${i}@acme.test>`,
      bodyText: "Sounds good.",
      date: new Date(Date.now() - (i + 1) * 20 * 60_000).toISOString(),
    }));
    // Older than the window, and newer than all of them by uid order.
    messages.push({
      subject: "Re: proposal from last month",
      from: "old <old@acme.test>",
      bodyText: "Stale.",
      date: daysAgo(30),
    });
    h.provider.seedAccount(h.account.id, "you@work.test", messages);
  }

  it("reads the whole window instead of the newest page", async () => {
    let withSince: any;
    let withoutSince: any;
    const h = await harness(async (call) => {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      withSince = await call("messages_list", {
        account: "work",
        since,
        limit: 100,
      });
      // What the prompt used to get: a period asked for in prose only.
      withoutSince = await call("messages_list", { account: "work", limit: 25 });
    });
    seedBusyDay(h);
    await runAutomation(h, "Reply triage", TRIAGE_PROMPT);

    expect(h.runs[0].result.status).toBe("ok");
    expect(withSince.messages).toHaveLength(40);
    expect(withoutSince.messages).toHaveLength(25);

    // The specific reply that used to be missed: 30th newest, inside the day.
    const subjects = withSince.messages.map((m: any) => m.subject);
    expect(subjects).toContain("Re: proposal 29");
    expect(withoutSince.messages.map((m: any) => m.subject)).not.toContain(
      "Re: proposal 29",
    );
    // And the filter is a window, not just a bigger page.
    expect(subjects).not.toContain("Re: proposal from last month");
  });

  it("marks a replier as in conversation, so outreach stops mailing them", async () => {
    let state: any;
    const h = await harness(async (call) => {
      await call("crm_sync");
      const { states } = await call("crm_outreach_state", {
        emails: ["person0@acme.test"],
      });
      state = states[0];
    });
    seedBusyDay(h);
    // We wrote first; their reply is in the fixture inbox above.
    const contact = h.platform.crmStore.upsertContact({
      email: "person0@acme.test",
    });
    h.platform.crmStore.addInteraction({
      contactId: contact.id,
      accountId: h.account.id,
      messageId: "ours",
      direction: "out",
      at: daysAgo(2),
    });

    await runAutomation(h, "Reply triage", TRIAGE_PROMPT);

    expect(h.runs[0].result.status).toBe("ok");
    expect(state.status).toBe("replied");
    expect(state.contactable).toBe(false);
    expect(state.blockedBy).toBe("in_conversation");
  });

  it("reports a contact it was asked about but could not find", async () => {
    // Silently dropping an unknown id would read as "not blocked" to the
    // caller, which is the double-send failure wearing a different hat.
    //
    // The CRM is deliberately NOT empty here. An earlier version of this test
    // seeded nothing, so it passed while the tool was answering a question
    // about one unknown address with a page of every contact in the database.
    let answer: any;
    const h = await harness(async (call) => {
      answer = await call("crm_outreach_state", { emails: ["ghost@acme.test"] });
    });
    for (const email of ["a@acme.test", "b@acme.test", "c@acme.test"]) {
      h.platform.crmStore.upsertContact({ email });
    }
    await runAutomation(h, "Reply triage", TRIAGE_PROMPT);

    expect(answer.states).toEqual([]);
    expect(answer.missing).toEqual(["ghost@acme.test"]);
  });

  it("never answers a question about named people with a page of strangers", async () => {
    // Same hazard with contactableOnly on, which is how outreach calls it:
    // the fallback would have handed back a list of mailable strangers.
    let answer: any;
    const h = await harness(async (call) => {
      answer = await call("crm_outreach_state", {
        contactIds: ["no-such-id"],
        emails: ["ghost@acme.test"],
        contactableOnly: true,
      });
    });
    for (const email of ["d@acme.test", "e@acme.test"]) {
      h.platform.crmStore.upsertContact({ email });
    }
    await runAutomation(h, "Reply triage", TRIAGE_PROMPT);

    expect(answer.states).toEqual([]);
    expect(answer.missing).toEqual(["no-such-id", "ghost@acme.test"]);
  });

  it("asks about one person once, however it was named", async () => {
    let answer: any;
    const h = await harness(async (call) => {
      const { states } = await call("crm_outreach_state", { query: "" });
      const target = states[0];
      answer = await call("crm_outreach_state", {
        contactIds: [target.contactId],
        emails: [target.email],
      });
    });
    h.platform.crmStore.upsertContact({ email: "twice@acme.test" });
    await runAutomation(h, "Reply triage", TRIAGE_PROMPT);

    expect(h.runs[0].result.status).toBe("ok");
    expect(answer.states).toHaveLength(1);
  });
});

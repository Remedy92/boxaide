/**
 * Automation MCP tools. Surface: docs/specs/agent-platform.md.
 * automation_create's description must teach the agent to write the prompt
 * as instructions to a future, context-free agent run.
 */
import type { Platform, ToolDef } from "../platform.js";

/**
 * The one thing an agent gets wrong here: it writes the prompt as a note to
 * itself, in the middle of a conversation it can still see. The future run
 * has none of that — new process, empty transcript, no user to ask.
 */
const PROMPT_GUIDANCE =
  "Write prompt as standalone instructions to a different agent that will run later with NO memory of this conversation and NO user to ask: name the accounts, folders, search terms, contacts and thresholds explicitly instead of saying 'the ones we discussed', and say what to produce (a note, a CRM update, a queued draft). The run cannot talk to anyone and cannot send email.";

const CRON_DESC =
  "5-field cron in server local time: 'minute hour day-of-month month day-of-week'. Example: '0 8 * * 1-5' is 08:00 on weekdays. Rejected if it does not parse.";

export const AUTOMATION_TOOLS: ToolDef[] = [
  {
    name: "automation_create",
    description: `Schedule a recurring agent run. ${PROMPT_GUIDANCE} Use this only when the user wants work to repeat on a schedule — for something to do right now, just do it.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Unique, human-readable." },
        cron: { type: "string", description: CRON_DESC },
        prompt: {
          type: "string",
          description: `Instructions for the future run. ${PROMPT_GUIDANCE}`,
        },
        agentId: {
          type: "string",
          description:
            "Agent CLI id from the Boxaide Agents list. Omit to use the first installed one.",
        },
        model: {
          type: "string",
          description:
            "Model id that agent's CLI offers. Omit to use the CLI's own default. A cheap model is usually right for a run that repeats every day.",
        },
      },
      required: ["name", "cron", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_update",
    description: `Change an existing automation. Only the fields you pass change. Set enabled false to pause it — prefer that over automation_delete, which loses the prompt and the run history. ${PROMPT_GUIDANCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        automationId: { type: "string" },
        name: { type: "string" },
        cron: { type: "string", description: CRON_DESC },
        prompt: { type: "string" },
        agentId: { type: "string" },
        // Changing agentId alone clears the stored model: an id belongs to one
        // CLI. Pass both to switch agent and pick a model in one call.
        model: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_delete",
    description:
      "Delete an automation and its run history, permanently. To stop it temporarily use automation_update with enabled false instead.",
    inputSchema: {
      type: "object" as const,
      properties: { automationId: { type: "string" } },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  {
    name: "automations_list",
    description:
      "List every automation with its schedule, prompt, last/next run times, and the outcome of its last run.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "automation_run_now",
    description:
      "Queue an automation to run immediately, without changing its schedule. Returns once it is queued, not once it has finished — read automation_runs_list for the outcome. One run happens at a time, so it may wait.",
    inputSchema: {
      type: "object" as const,
      properties: { automationId: { type: "string" } },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_runs_list",
    description:
      "Run history with status, exit code, and the tail of each run's output. Use it to find out why an automation is not doing what the user expected.",
    inputSchema: {
      type: "object" as const,
      properties: {
        automationId: {
          type: "string",
          description: "Omit for recent runs across all automations.",
        },
        limit: { type: "number", default: 20 },
      },
      additionalProperties: false,
    },
  },
];

export const AUTOMATION_TOOL_NAMES: ReadonlySet<string> = new Set(
  AUTOMATION_TOOLS.map((t) => t.name),
);

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function required(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (value === undefined || value === "") throw new Error(`${key} is required`);
  return value;
}

export async function dispatchAutomationTool(
  platform: Platform,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const store = platform.automationStore;
  switch (name) {
    case "automation_create":
      return {
        automation: store.create({
          name: required(args, "name"),
          cron: required(args, "cron"),
          prompt: required(args, "prompt"),
          agentId: str(args, "agentId") ?? null,
          model: str(args, "model") ?? null,
        }),
      };
    case "automation_update": {
      const id = required(args, "automationId");
      const updated = store.update(id, {
        name: str(args, "name"),
        cron: str(args, "cron"),
        prompt: str(args, "prompt"),
        agentId: args.agentId === undefined ? undefined : (str(args, "agentId") ?? null),
        model: args.model === undefined ? undefined : (str(args, "model") ?? null),
        enabled:
          typeof args.enabled === "boolean" ? (args.enabled as boolean) : undefined,
      });
      if (!updated) throw new Error(`unknown automation: ${id}`);
      return { automation: updated };
    }
    case "automation_delete": {
      const id = required(args, "automationId");
      if (!store.delete(id)) throw new Error(`unknown automation: ${id}`);
      return { deleted: true };
    }
    case "automations_list":
      return { automations: store.list() };
    case "automation_run_now": {
      const id = required(args, "automationId");
      if (!store.get(id)) throw new Error(`unknown automation: ${id}`);
      // Not awaited: a run can take fifteen minutes and the tool call must
      // not hold the agent's MCP request open for it.
      void platform.scheduler.runNow(id).catch(() => {});
      return { queued: true };
    }
    case "automation_runs_list": {
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      return {
        runs: store.listRuns({ automationId: str(args, "automationId"), limit }),
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/**
 * The workspace-memory text a launch's prompt carries.
 *
 * The memory store gave agents a place to keep notes
 * (`<agentWorkDir>/memory/`, src/memory/store.ts) and, because an agent is a
 * CLI process standing in that workdir, the native file tools to maintain
 * them. What no CLI knows on its own is that the notes exist, whether it may
 * build them, and what is in them. This module turns the directory into that
 * paragraph, once per launch: the reads are synchronous because launch is,
 * and capping, not skipping, is what keeps a big set of notes from swelling
 * every prompt.
 *
 * Three shapes, and the difference is who is listening:
 *  - A chat or driven launch has the user at the other end, so before any
 *    notes exist it may OFFER to build them and must take no for an answer.
 *    Once the index exists the offer is replaced by the index itself and the
 *    duty to keep it current.
 *  - An automation run has nobody to consent to a skim, and its working
 *    directory is a throwaway one the notes are not in, so it gets neither
 *    the offer nor the duty: the index and the two files a draft needs are
 *    inlined as plain background, and an install with no notes injects
 *    nothing at all.
 *
 * Every read is guarded. Missing files are the normal first-session state,
 * and an unreadable one must degrade to the same shapes — a launch never
 * fails over its notes.
 */
import {
  hasMemoryIndex,
  readMemoryFileSync,
  readMemoryIndexSync,
} from "../memory/store.js";

/** Characters of MEMORY.md carried into a prompt before the tail is cut. */
export const INDEX_CAP = 2_000;

/** Characters of one topic file inlined into an automation run's prompt. */
export const TOPIC_CAP = 1_500;

/** Marks a cut tail, phrased so an agent reads it as "there was more". */
const ELLIPSIS = "\n[… truncated]";

/**
 * The ask-first block: what the notes are, that there are none yet, and the
 * one consented way to build them. The offer is worded as a single sentence
 * the user can answer in one word, because an agent that starts skimming the
 * mailbox uninvited is reading mail nobody handed it yet.
 */
const ASK_FIRST = `Workspace notes: you keep what you learn about my workspace as markdown
files in ./memory/ — MEMORY.md is the index. You have none yet. Offer to build
them once, briefly — "Give me a minute to skim your mailbox and calendar so
drafts sound like you — want me to?" — and build them only if I agree. Then:
accounts_list and folders_list to see what I have; messages_search and
messages_list over Sent, message_get on a few sent messages for my voice and
signature; crm_sync, then crm_orgs_list and crm_contacts_search for who
matters; calendar_accounts_list and agenda_view for my timezone and cadence;
web_fetch our site if you can find it. About fifteen tool calls, then stop.
Write ./memory/MEMORY.md (a short index, one line per file) plus company.md,
voice.md and people.md. Every fact names its source. Never store a password or
key. If I decline, drop it for this session.`;

/** What a chat or driven launch sees once the index exists. */
const NOTES_EXIST = `Workspace notes: your notes on my workspace live in ./memory/, next to
you. MEMORY.md is the index, below; the topic files it names sit beside it and
are read on demand when they become relevant. When you learn a durable fact
about my workspace, update those files yourself.`;

/** Opens an automation run's inlined notes. */
const RUN_HEADER = `Workspace notes for context, from my inbox agent's own notes: what my
company does, and how I write. Background for the task below.`;

/**
 * One memory file's text, or null when there is nothing usable. The store's
 * sync read answers null only for a missing file; a file that exists but
 * cannot be read (permissions, a directory sitting where the file belongs)
 * would throw, and a launch must not.
 */
function readNote(dataDir: string, name: string): string | null {
  try {
    return readMemoryFileSync(dataDir, name);
  } catch {
    return null;
  }
}

/** The text cut to maxChars total, ellipsis included. */
function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - ELLIPSIS.length)) + ELLIPSIS;
}

/**
 * The usable index, or null: absent, unreadable and empty all count as no
 * notes worth speaking of, which is the state the ask-first block describes.
 * Read through readMemoryIndexSync — the general sync read's name rule is the
 * REST one, and the uppercase index sits outside it by design.
 */
function readIndex(dataDir: string): string | null {
  if (!hasMemoryIndex(dataDir)) return null;
  try {
    return readMemoryIndexSync(dataDir);
  } catch {
    return null;
  }
}

/**
 * The block for a chat or driven launch: the ask-first instructions until the
 * agent has built its index, then the capped index plus the update duty.
 */
export function chatMemoryBlock(dataDir: string): string {
  const index = readIndex(dataDir);
  if (!index) return ASK_FIRST;
  return `${NOTES_EXIST}\n\nMEMORY.md:\n${cap(index, INDEX_CAP)}`;
}

/**
 * The block for an automation run: the capped index with company.md and
 * voice.md inlined when they exist, empty string when there is nothing to
 * inline — never the ask-first wording, which a run could not act on.
 */
export function runMemoryBlock(dataDir: string): string {
  const index = readIndex(dataDir);
  if (!index) return "";
  const sections = [cap(index, INDEX_CAP)];
  for (const [name, label] of [
    ["company.md", "Company notes"],
    ["voice.md", "Voice notes"],
  ] as const) {
    const note = readNote(dataDir, name);
    if (note) sections.push(`${label}:\n${cap(note, TOPIC_CAP)}`);
  }
  return `${RUN_HEADER}\n\n${sections.join("\n\n")}`;
}

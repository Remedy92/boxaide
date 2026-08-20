/**
 * The one definition of what a master commit subject may say.
 *
 * A subject on master is not a note to the next reader of the diff. `ship.sh`
 * turns it into the release body, and Boxaide prints that body under "What is
 * new" to somebody deciding whether to restart. There is no second place to
 * fix the wording later, so the rule is checked three times:
 *
 *   - CI, on the pull request title, which is the subject a squash-merge
 *     writes. That is the only gate that fires before the words reach master;
 *   - `ship.sh`, over the notes it computed, for anything committed directly;
 *   - the `commit-msg` hook, for a local commit, if the hooks are installed.
 *
 * What is checkable here is the shape, not the truth. No rule below can tell
 * whether the sentence describes what actually shipped.
 */
import { pathToFileURL } from "node:url";

// 80, not 72: the longest good subject in this history is 81 characters and
// the useful ones cluster at 66-77. A tighter ceiling rejects prose that is
// already doing the job.
export const MAX_LENGTH = 80;

// Openers that describe the diff instead of the app. "Refactor sweep handler"
// is the exact failure this catches: true of the patch, meaningless in a
// release note. Inflections included: "Refactoring", "Bumps" fail too.
// "update" and "cleanup" are deliberately absent. Both rejected sentences that
// were already good copy: "Update the app in place, and say so in the rail",
// "Clean up four leftovers from the HTML mail reader". A word that blocks a
// good line is not worth the bad lines it catches.
const DIFF_WORDS = new Set([
  "bump", "bumps", "bumped", "bumping",
  "misc",
  "refactor", "refactors", "refactored", "refactoring",
  "tweak", "tweaks", "tweaked", "tweaking",
  "wip",
]);

// Subjects that are never release copy and never reach the notes. `ship.sh`
// drops merges and its own "Cut 0.2.26"; git's own fixup!/squash! markers are
// rewritten by the rebase that consumes them.
const EXEMPT = [
  /^Merge /,
  /^Revert "/,
  /^(fixup|squash|amend)! /,
  /^Cut \d+\.\d+\.\d+$/,
];

/** Drop the "(#84)" a squash-merge appends, which is not the author's words. */
export function stripPrNumber(subject) {
  return subject.replace(/ *\(#\d+\)$/, "");
}

export function isExempt(subject) {
  return EXEMPT.some((pattern) => pattern.test(subject));
}

/**
 * Return the problems with one subject. Empty array means it passes.
 */
export function checkSubject(raw) {
  const subject = stripPrNumber(String(raw ?? "").trim());
  if (isExempt(subject)) return [];

  const problems = [];
  if (subject === "") {
    return ["is empty"];
  }
  if (subject.length > MAX_LENGTH) {
    problems.push(`is ${subject.length} characters; the ceiling is ${MAX_LENGTH}`);
  }
  const prefix = /^[a-z]+(\([^)]*\))?!?:/.exec(subject);
  if (prefix) {
    problems.push(`starts with the commit-type prefix "${prefix[0]}"; write the sentence instead`);
  } else {
    const first = subject.split(/\s+/)[0].toLowerCase().replace(/[^a-z]+$/, "");
    if (DIFF_WORDS.has(first)) {
      problems.push(`opens with "${first}", which describes the diff, not the app`);
    }
    if (!/^[A-Z0-9]/.test(subject)) {
      problems.push("does not start with a capital letter");
    }
  }
  if (/\.$/.test(subject)) {
    problems.push("ends with a full stop; a release note line takes none");
  }
  if (subject.includes("—")) {
    problems.push("contains an em dash; use a comma, a colon, or two sentences");
  }
  return problems;
}

/**
 * Check many subjects at once. Returns one printable report, or "" if clean.
 */
export function report(subjects) {
  const lines = [];
  for (const subject of subjects) {
    const problems = checkSubject(subject);
    if (problems.length === 0) continue;
    lines.push(`  ${subject}`);
    for (const problem of problems) lines.push(`    - ${problem}`);
  }
  return lines.join("\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv) {
  let subjects;
  if (argv.length > 0) {
    subjects = argv;
  } else {
    // Whole lines from stdin. A leading "- " is how ship.sh formats a note,
    // and a "#" line is how git formats the commit-message template.
    subjects = (await readStdin())
      .split("\n")
      .map((line) => line.replace(/^- /, "").trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  }
  const problems = report(subjects);
  if (problems === "") {
    process.stdout.write(`subject ok (${subjects.length} checked)\n`);
    return;
  }
  process.stderr.write(
    `A subject on master is what Boxaide shows under "What is new".\n${problems}\n` +
      "Write what the app now does, in the present tense, for somebody who\n" +
      "does not read this repo. See AGENTS.md.\n",
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}

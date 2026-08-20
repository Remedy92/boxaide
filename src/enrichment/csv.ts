/**
 * CSV parsing for contact import. Owned by the enrichment module because
 * importing a bought or scraped list is the same job as enriching one, and
 * the CRM has no business knowing about spreadsheet dialects.
 *
 * The parser is written out rather than pulled from a package: Boxaide takes
 * no new dependencies, and the dialect that matters here is small. It handles
 * quoted fields, commas and newlines inside quotes, doubled quotes as an
 * escape, CRLF, and a UTF-8 byte order mark from Excel.
 *
 * A "website" or "orgDomain" cell usually holds a URL, not a bare domain, and
 * the CRM matches organisations by exact domain. The fold onto "acme.com" is
 * bareDomain in src/domain.ts, shared with the prospecting adapter so the two
 * import paths land on one organisation row rather than two.
 */
import { bareDomain } from "../domain.js";

/** Highest number of data rows one import call accepts. */
export const MAX_IMPORT_ROWS = 500;

export type ImportContactRow = {
  email: string;
  name: string | null;
  title: string | null;
  org: string | null;
  orgDomain: string | null;
  tags: string[];
  /** 1-based line number in the supplied text, header included. */
  line: number;
};

export type SkippedRow = {
  /** 1-based line number in the supplied text, header included. */
  line: number;
  reason: string;
  email?: string;
};

export type ParsedImport = {
  rows: ImportContactRow[];
  skipped: SkippedRow[];
};

/**
 * Header spellings seen in the wild, folded onto the six fields we keep.
 * Lookup is on the header lower-cased with everything but letters removed, so
 * "Org Domain", "org_domain" and "orgdomain" are one key.
 */
const HEADER_ALIASES: Record<string, keyof ImportContactRow> = {
  email: "email",
  emailaddress: "email",
  mail: "email",
  name: "name",
  fullname: "name",
  contactname: "name",
  title: "title",
  jobtitle: "title",
  role: "title",
  org: "org",
  organisation: "org",
  organization: "org",
  company: "org",
  companyname: "org",
  orgdomain: "orgDomain",
  domain: "orgDomain",
  companydomain: "orgDomain",
  website: "orgDomain",
  tags: "tags",
  tag: "tags",
};

/**
 * Deliberately loose. This rejects the things that are certainly not an
 * address, spaces, a missing @, a domain with no dot, and leaves the real
 * verdict to enrich_verify_email. A stricter regex would drop valid addresses
 * and there is a paid verifier one tool call away.
 */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/;

export function isSyntacticEmail(value: string): boolean {
  return value.length <= 320 && EMAIL_RE.test(value);
}

/** Split one CSV document into rows of raw cells. Empty lines are dropped. */
export function splitCsv(text: string): { cells: string[]; line: number }[] {
  const input = text.replace(/^﻿/, "");
  const out: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let started = false;

  const endField = () => {
    cells.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // A trailing newline leaves one empty cell behind; that is not a row.
    if (!(cells.length === 1 && cells[0].trim() === "")) {
      out.push({ cells, line: rowLine });
    }
    cells = [];
    started = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (!started) {
      rowLine = line;
      started = true;
    }
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      // Only an opening quote at the start of a field opens a quoted run; a
      // stray quote mid-field is data, as in O"Brien.
      field = "";
      quoted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r") {
      // Swallowed; the \n that follows ends the row.
    } else if (ch === "\n") {
      endRow();
      line++;
    } else {
      field += ch;
    }
  }
  if (started || field !== "" || cells.length > 0) endRow();
  return out;
}

function headerKey(raw: string): keyof ImportContactRow | null {
  const key = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
  return HEADER_ALIASES[key] ?? null;
}

function cell(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  return text === "" ? null : text;
}

/**
 * Parse contact rows out of CSV text. Every row that does not make it into
 * `rows` comes back in `skipped` with the reason, so an agent can tell a human
 * what was left behind instead of reporting a smaller number than expected.
 *
 * Throws when the document is over the row cap: a partial import that looks
 * like a whole one is worse than a refusal the caller can act on.
 */
export function parseContactCsv(text: string): ParsedImport {
  const records = splitCsv(text);
  if (records.length === 0) throw new Error("csv is empty");

  const header = records[0];
  const columns = header.cells.map(headerKey);
  const emailAt = columns.indexOf("email");
  if (emailAt === -1) {
    throw new Error(
      "csv needs an 'email' column; optional columns are name, title, org, orgDomain, tags",
    );
  }

  const body = records.slice(1);
  if (body.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `csv has ${body.length} rows; at most ${MAX_IMPORT_ROWS} per call, split the file`,
    );
  }

  const rows: ImportContactRow[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Map<string, number>();

  for (const record of body) {
    const pick = (field: keyof ImportContactRow): string | null => {
      const at = columns.indexOf(field);
      return at === -1 ? null : cell(record.cells[at]);
    };

    const email = (cell(record.cells[emailAt]) ?? "").toLowerCase();
    if (!email) {
      skipped.push({ line: record.line, reason: "no email" });
      continue;
    }
    if (!isSyntacticEmail(email)) {
      skipped.push({ line: record.line, reason: "not an email address", email });
      continue;
    }
    const first = seen.get(email);
    if (first !== undefined) {
      skipped.push({
        line: record.line,
        reason: `duplicate of line ${first}`,
        email,
      });
      continue;
    }
    seen.set(email, record.line);

    const tags = (pick("tags") ?? "")
      .split(/[;|,]/)
      .map((t) => t.trim())
      .filter((t) => t !== "");

    rows.push({
      email,
      name: pick("name"),
      title: pick("title"),
      org: pick("org"),
      orgDomain: bareDomain(pick("orgDomain")),
      tags,
      line: record.line,
    });
  }

  return { rows, skipped };
}

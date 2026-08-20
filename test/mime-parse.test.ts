import { describe, it, expect } from "vitest";
import {
  MAX_BODY_HTML_CHARS,
  MAX_RFC822_SOURCE_BYTES,
  parseRfc822,
} from "../src/provider/mime.js";
import { messageFromImapSource } from "../src/provider/imap-smtp.js";

/** RFC822 samples — same shapes Gmail/IMAP commonly return. */
const SAMPLES = {
  sevenBit: [
    "From: alice@example.com",
    "To: bob@example.com",
    "Subject: Seven bit plain",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    "Hello from seven-bit body.",
  ].join("\r\n"),

  quotedPrintable: [
    "From: alice@example.com",
    "To: bob@example.com",
    "Subject: QP message",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 with soft=20break and=0Anew line.",
  ].join("\r\n"),

  // "Hello base64 body." base64-encoded
  base64: [
    "From: alice@example.com",
    "To: bob@example.com",
    "Subject: Base64 message",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Hello base64 body.", "utf8").toString("base64"),
  ].join("\r\n"),

  multipartAlternative: [
    "From: alice@example.com",
    "To: bob@example.com",
    "Subject: Multipart alt",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="bound123"',
    "",
    "--bound123",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Plain part says hello.", "utf8").toString("base64"),
    "",
    "--bound123",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>HTML part says <b>hello</b>.</p>",
    "",
    "--bound123--",
  ].join("\r\n"),

  // What a real Accept/Decline lands as: text/calendar inline beside the text
  // part, method on the Content-Type, no filename and no disposition.
  imipReply: [
    "From: bob@example.com",
    "To: alice@example.com",
    "Subject: Accepted: Sync",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="imip1"',
    "",
    "--imip1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Bob has accepted the invitation.",
    "",
    "--imip1",
    'Content-Type: text/calendar; charset=utf-8; method=REPLY',
    "",
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    "UID:evt-reply-1@example.com",
    "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
    "--imip1--",
  ].join("\r\n"),

  // The other common shape: the .ics arrives base64 as a named attachment.
  icsAttachment: [
    "From: alice@example.com",
    "To: bob@example.com",
    "Subject: Invitation: Sync",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mix1"',
    "",
    "--mix1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please see the attached invite.",
    "",
    "--mix1",
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="invite.ics"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="invite.ics"',
    "",
    Buffer.from(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:evt-request-1@example.com",
        "SUMMARY:Sync",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
      "utf8",
    ).toString("base64"),
    "",
    "--mix1--",
  ].join("\r\n"),
};

describe("parseRfc822 (shipped MIME path)", () => {
  it("decodes 7bit text/plain", async () => {
    const p = await parseRfc822(SAMPLES.sevenBit);
    expect(p.bodyText).toContain("Hello from seven-bit body.");
    expect(p.subject).toBe("Seven bit plain");
    expect(p.from).toMatch(/alice@example.com/);
  });

  it("decodes quoted-printable (not soft-only)", async () => {
    const p = await parseRfc822(SAMPLES.quotedPrintable);
    expect(p.bodyText).toContain("Café");
    expect(p.bodyText).not.toMatch(/=C3=A9/);
    expect(p.bodyText).not.toMatch(/=20/);
  });

  it("decodes base64 text/plain to readable text (Gmail default)", async () => {
    const p = await parseRfc822(SAMPLES.base64);
    expect(p.bodyText).toContain("Hello base64 body.");
    // Must NOT return raw base64
    expect(p.bodyText).not.toMatch(/SGVsbG8/);
    expect(p.bodyText.trim()).toBe("Hello base64 body.");
  });

  it("decodes multipart/alternative with base64 plain + html", async () => {
    const p = await parseRfc822(SAMPLES.multipartAlternative);
    expect(p.bodyText).toContain("Plain part says hello.");
    expect(p.bodyHtml).toMatch(/HTML part says/i);
    expect(p.bodyText).not.toMatch(/UGxhaW4/); // raw base64 of "Plain..."
  });

  it("rejects oversized sources before MIME parsing", async () => {
    await expect(
      parseRfc822(Buffer.alloc(MAX_RFC822_SOURCE_BYTES + 1, 0x61)),
    ).rejects.toThrow(/safety limit/);
  });

  it("caps raw HTML, cutting on a tag boundary", async () => {
    const html = `<p>${"x".repeat(MAX_BODY_HTML_CHARS + 100)}</p>`;
    const raw = [
      "From: a@example.com",
      "To: b@example.com",
      "Subject: large html",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
    ].join("\r\n");
    const parsed = await parseRfc822(raw);
    /* Cut at the last `<`, so never longer than the cap and never severed
       mid-tag: the trailing `</p>` is gone and nothing partial replaces it. */
    expect(parsed.bodyHtml!.length).toBeLessThanOrEqual(MAX_BODY_HTML_CHARS);
    expect(parsed.bodyHtml!.length).toBeGreaterThan(MAX_BODY_HTML_CHARS - 100);
    expect(parsed.bodyHtml!.endsWith("<")).toBe(false);
    expect(parsed.bodyHtml).not.toMatch(/<[a-z/][^>]*$/i);
  });

  it("keeps a message whose bulk is an inlined cid: image", async () => {
    /* mailparser rewrites cid: to a data: URI before this sees the html, so
       an ordinary photo dwarfs the markup around it. The old cap severed the
       document; the body after the image has to survive. */
    const image = "A".repeat(400_000);
    const html = `<p>before</p><img src="data:image/png;base64,${image}"><p>after</p>`;
    const raw = [
      "From: a@example.com",
      "To: b@example.com",
      "Subject: inline image",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
    ].join("\r\n");
    const parsed = await parseRfc822(raw);
    expect(parsed.bodyHtml).toContain("<p>after</p>");
  });
});

describe("inbound calendar part (iMIP)", () => {
  it("reads the inline text/calendar part and its method", async () => {
    const p = await parseRfc822(SAMPLES.imipReply);
    expect(p.calendar?.method).toBe("REPLY");
    expect(p.calendar?.content).toContain("BEGIN:VCALENDAR");
    expect(p.calendar?.content).toContain("UID:evt-reply-1@example.com");
    expect(p.calendar?.content).toContain("PARTSTAT=ACCEPTED");
    // The text part still has to survive alongside it.
    expect(p.bodyText).toContain("Bob has accepted the invitation.");
  });

  it("decodes a base64 .ics attachment", async () => {
    const p = await parseRfc822(SAMPLES.icsAttachment);
    expect(p.calendar?.method).toBe("REQUEST");
    expect(p.calendar?.content).toContain("UID:evt-request-1@example.com");
    // Must NOT hand back the raw base64.
    expect(p.calendar?.content).not.toMatch(/QkVHSU4/);
    expect(p.bodyText).toContain("Please see the attached invite.");
  });

  it("leaves calendar undefined on a message without one", async () => {
    const plain = await parseRfc822(SAMPLES.sevenBit);
    expect(plain.calendar).toBeUndefined();
    const alt = await parseRfc822(SAMPLES.multipartAlternative);
    expect(alt.calendar).toBeUndefined();
  });

  it("caps stored calendar content", async () => {
    const huge = [
      "From: alice@example.com",
      "To: bob@example.com",
      "Subject: Big invite",
      "MIME-Version: 1.0",
      "Content-Type: text/calendar; charset=utf-8; method=REQUEST",
      "",
      `BEGIN:VCALENDAR\r\nX-PAD:${"a".repeat(150_000)}\r\nEND:VCALENDAR`,
    ].join("\r\n");
    const p = await parseRfc822(huge);
    expect(p.calendar?.content.length).toBe(100_000);
  });

  it("surfaces the calendar on the assembled message", async () => {
    const msg = await messageFromImapSource(
      "acct1",
      "INBOX",
      11,
      SAMPLES.imipReply,
    );
    expect(msg.calendar?.method).toBe("REPLY");
    expect(msg.calendar?.content).toContain("UID:evt-reply-1@example.com");

    const plain = await messageFromImapSource(
      "acct1",
      "INBOX",
      12,
      SAMPLES.sevenBit,
    );
    expect(plain.calendar).toBeUndefined();
  });
});

describe("threading headers (reply chain)", () => {
  const threaded = [
    "From: alice@example.com",
    "To: bob@example.com",
    "Subject: Re: thread",
    "Message-ID: <c@example.com>",
    "In-Reply-To: <b@example.com>",
    "References: <a@example.com> <b@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Third message in the thread.",
  ].join("\r\n");

  it("flattens the References chain into one string", async () => {
    const p = await parseRfc822(threaded);
    expect(p.references).toBe("<a@example.com> <b@example.com>");
    expect(p.messageId).toBe("<c@example.com>");
  });

  it("exposes references on the assembled message so a reply can thread", async () => {
    const msg = await messageFromImapSource("acct1", "INBOX", 9, threaded);
    expect(msg.references).toBe("<a@example.com> <b@example.com>");
    expect(msg.messageId).toBe("<c@example.com>");
  });

  it("leaves references undefined on a message that starts a thread", async () => {
    const p = await parseRfc822(SAMPLES.sevenBit);
    expect(p.references).toBeUndefined();
  });
});

describe("messageFromImapSource (ImapSmtpProvider getMessage body path)", () => {
  it("returns decoded body for base64 RFC822 via shipped assembler", async () => {
    const msg = await messageFromImapSource(
      "acct1",
      "INBOX",
      42,
      SAMPLES.base64,
    );
    expect(msg.id).toBe("acct1:INBOX:42");
    expect(msg.uid).toBe(42);
    expect(msg.bodyText).toBe("Hello base64 body.");
    expect(msg.subject).toBe("Base64 message");
    expect(msg.from).toMatch(/alice@example.com/);
    expect(msg.to).toMatch(/bob@example.com/);
  });

  it("returns decoded bodies for multipart/alternative", async () => {
    const msg = await messageFromImapSource(
      "acct1",
      "INBOX",
      7,
      SAMPLES.multipartAlternative,
    );
    expect(msg.bodyText).toContain("Plain part says hello.");
    expect(msg.bodyHtml).toContain("HTML part says");
    expect(msg.subject).toBe("Multipart alt");
  });

  it("decodes quoted-printable through the same getMessage path", async () => {
    const msg = await messageFromImapSource(
      "acct1",
      "INBOX",
      3,
      SAMPLES.quotedPrintable,
    );
    expect(msg.bodyText).toContain("Café");
    expect(msg.bodyText).not.toContain("=C3=A9");
  });

  it("decodes 7bit through the same getMessage path", async () => {
    const msg = await messageFromImapSource(
      "acct1",
      "INBOX",
      1,
      SAMPLES.sevenBit,
    );
    expect(msg.bodyText).toContain("Hello from seven-bit body.");
  });
});

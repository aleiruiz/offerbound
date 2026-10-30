import { readFileSync } from "node:fs";
import type { gmail_v1 } from "@googleapis/gmail";
import { describe, expect, it } from "vitest";
import { parseAddressList, parseFullMessage } from "./mime.js";

function fixture(name: string): gmail_v1.Schema$Message {
  const url = new URL(`./__fixtures__/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as gmail_v1.Schema$Message;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

const ICS_SMALL = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:big-1@quarry.example",
  "DTSTART:20261103T200000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("parseFullMessage", () => {
  it("prefers text/plain over text/html", () => {
    const parsed = parseFullMessage(fixture("alternative-plain-html"));
    expect(parsed.textBody).toContain("Thanks for applying to Quarry Labs");
    expect(parsed.textBody).not.toContain("<p>");
    expect(parsed.textBody).not.toContain("https://quarry.example/jobs/42");
  });

  it("turns an HTML-only body into text with links written as 'text [url]'", () => {
    const parsed = parseFullMessage(fixture("html-only"));
    expect(parsed.textBody).toContain("Apply at our portal [https://quarry.example/jobs/42].");
    expect(parsed.textBody).not.toContain("<");
  });

  it("drops script and style content when converting HTML", () => {
    const parsed = parseFullMessage(fixture("html-only-multipart"));
    expect(parsed.textBody).toContain("pick a time [https://cal.quarry.example/ana]");
    expect(parsed.textBody).not.toContain("alert(1)");
    expect(parsed.textBody).not.toContain("color:red");
    expect(parsed.textBody).not.toContain("INTERVIEW");
  });

  it("decodes base64url and quoted-printable parts and keeps 'Ñandú' intact", () => {
    expect(parseFullMessage(fixture("base64url-utf8")).textBody).toBe(
      "Bienvenido a Ñandú Systems. ¿Hablamos mañana?",
    );
    const utf8 = parseFullMessage(fixture("quoted-printable-utf8")).textBody;
    expect(utf8).toContain("Hola Ñandú Systems,");
    expect(utf8).toContain("Nos gustaría hablar con tu familia.");
    const latin1 = parseFullMessage(fixture("quoted-printable-latin1")).textBody;
    expect(latin1).toContain("Hola Ñandú Systems,");
    expect(latin1).toContain("Total=42");
  });

  it("leaves already-decoded text alone when the part header still says quoted-printable", () => {
    const decoded = [
      "Open https://quarry.example/a?x=AB&y=zz now",
      "Apply: https://jobs.quarry.example/apply?jobId=12345",
      "Token: https://jobs.quarry.example/t?t=abc123",
      "Bold: https://jobs.quarry.example/t?k=ABCDEF",
    ];
    for (const text of decoded) {
      const msg: gmail_v1.Schema$Message = {
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Content-Type", value: "text/plain; charset=utf-8" },
            { name: "Content-Transfer-Encoding", value: "quoted-printable" },
          ],
          body: { data: b64(text) },
        },
      };
      expect(parseFullMessage(msg).textBody).toBe(text);
    }
  });

  it("decodes quoted-printable that shows a soft line break, =3D or a high-byte escape", () => {
    const qp = (raw: string): string =>
      parseFullMessage({
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Content-Transfer-Encoding", value: "quoted-printable" }],
          body: { data: b64(raw) },
        },
      }).textBody;
    expect(qp("A long line that was=\r\n wrapped")).toBe("A long line that was wrapped");
    expect(qp("https://quarry.example/a?jobId=3D12345")).toBe(
      "https://quarry.example/a?jobId=12345",
    );
    expect(qp("Caf=C3=A9 =E2=80=94 ok")).toBe("Café — ok");
    // a control byte can never be a real escape: leave the text alone
    expect(qp("x=3D1 and =01")).toBe("x=3D1 and =01");
  });

  it("walks multipart/alternative nested inside multipart/mixed", () => {
    const parsed = parseFullMessage(fixture("mixed-nested-alternative"));
    expect(parsed.textBody).toContain("We would like to talk.");
    expect(parsed.icsEvents).toEqual([]);
  });

  it("reads a text/calendar part and an .ics attachment of 256 KB or less; ignores a larger one", () => {
    const part = parseFullMessage(fixture("invite-only"));
    expect(part.icsEvents).toHaveLength(1);
    expect(part.icsEvents[0]?.uid).toBe("evt-1001@quarry.example");

    const attachment = parseFullMessage(fixture("ics-attachment"));
    expect(attachment.textBody).toBe("See the attached calendar file.");
    expect(attachment.icsEvents).toHaveLength(1);
    expect(attachment.icsEvents[0]?.summary).toBe("Interview with Quarry Labs");

    const padding = "X-PAD:" + "a".repeat(256 * 1024) + "\r\n";
    const big = ICS_SMALL.replace("UID:", padding + "UID:");
    expect(Buffer.byteLength(big)).toBeGreaterThan(256 * 1024);
    const oversize: gmail_v1.Schema$Message = {
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: b64("hello") } },
          {
            mimeType: "application/ics",
            filename: "big.ics",
            body: { size: Buffer.byteLength(big), data: b64(big) },
          },
          {
            mimeType: "text/calendar",
            body: { size: Buffer.byteLength(big), data: b64(big) },
          },
        ],
      },
    };
    expect(parseFullMessage(oversize).icsEvents).toEqual([]);

    // Without a declared size the length of the data still decides.
    const undeclared: gmail_v1.Schema$Message = {
      payload: { mimeType: "application/ics", filename: "big.ics", body: { data: b64(big) } },
    };
    expect(parseFullMessage(undeclared).icsEvents).toEqual([]);

    const exactly = "X-PAD:" + "a".repeat(256 * 1024 - Buffer.byteLength(ICS_SMALL) - 8) + "\r\n";
    const atLimit = ICS_SMALL.replace("UID:", exactly + "UID:");
    expect(Buffer.byteLength(atLimit)).toBeLessThanOrEqual(256 * 1024);
    const ok: gmail_v1.Schema$Message = {
      payload: { mimeType: "text/calendar", body: { data: b64(atLimit) } },
    };
    expect(parseFullMessage(ok).icsEvents).toHaveLength(1);
  });

  it("ignores attachments whose data is not inline", () => {
    const msg: gmail_v1.Schema$Message = {
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: b64("body") } },
          { mimeType: "application/ics", filename: "invite.ics", body: { attachmentId: "att-1" } },
        ],
      },
    };
    const parsed = parseFullMessage(msg);
    expect(parsed.textBody).toBe("body");
    expect(parsed.icsEvents).toEqual([]);
  });

  it("an invite with no text part returns its icsEvents and an empty textBody", () => {
    const parsed = parseFullMessage(fixture("invite-only"));
    expect(parsed.textBody).toBe("");
    expect(parsed.icsEvents).toHaveLength(1);
    expect(parsed.icsEvents[0]).toMatchObject({
      method: "REQUEST",
      start: "2026-11-03T20:00:00.000Z",
      organizer: "ana@quarry.example",
    });
  });

  it("reads headers case-insensitively and splits the address lists", () => {
    const { headers } = parseFullMessage(fixture("alternative-plain-html"));
    expect(headers).toEqual({
      from: '"Ana Pérez" <ana@quarry.example>',
      fromName: "Ana Pérez",
      fromEmail: "ana@quarry.example",
      to: ["sam@owner.example"],
      cc: ["hiring@quarry.example", "lee@quarry.example"],
      subject: "Quarry Labs application",
      date: "Tue, 27 Oct 2026 10:00:00 -0600",
      listId: "<jobs.quarry.example>",
    });
  });

  it("decodes RFC 2047 encoded words in the subject and sender name", () => {
    const msg: gmail_v1.Schema$Message = {
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "FROM", value: "=?UTF-8?B?w5FhbmTDuiBIUg==?= <hr@nandu.example>" },
          { name: "subject", value: "=?UTF-8?Q?Entrevista_=C3=91and=C3=BA?=" },
        ],
        body: { data: b64("x") },
      },
    };
    const { headers } = parseFullMessage(msg);
    expect(headers.fromName).toBe("Ñandú HR");
    expect(headers.subject).toBe("Entrevista Ñandú");
    expect(headers.to).toEqual([]);
    expect(headers.listId).toBeNull();
    expect(headers.date).toBeNull();
  });

  it("returns an empty message for a payload with nothing in it", () => {
    const parsed = parseFullMessage({});
    expect(parsed.textBody).toBe("");
    expect(parsed.icsEvents).toEqual([]);
    expect(parsed.headers.from).toBeNull();
    expect(parsed.headers.fromEmail).toBeNull();
  });

  it("stops walking absurdly deep MIME trees without throwing", () => {
    let part: gmail_v1.Schema$MessagePart = { mimeType: "text/plain", body: { data: b64("deep") } };
    for (let i = 0; i < 500; i++) part = { mimeType: "multipart/mixed", parts: [part] };
    expect(() => parseFullMessage({ payload: part })).not.toThrow();
  });

  it("bounds the HTML it converts", () => {
    const html = "<p>" + "word ".repeat(400_000) + "</p>";
    const msg: gmail_v1.Schema$Message = {
      payload: { mimeType: "text/html", body: { data: b64(html) } },
    };
    // 128 KiB of HTML at most, so well under the 400k words sent
    expect(parseFullMessage(msg).textBody.length).toBeLessThanOrEqual(128 * 1024);
  });

  it("stops converting HTML parts once 512 KiB of HTML input is spent across the message", () => {
    // Each part is cut to 128 KiB of markup that converts to very little text, so four use the
    // whole budget and the fifth gets nothing.
    const filler = "<b></b>".repeat(20_000);
    const parts = Array.from({ length: 10 }, (_, i) => ({
      mimeType: "text/html",
      body: { data: b64(`<p>marker-${i}</p>${filler}`) },
    }));
    const msg: gmail_v1.Schema$Message = { payload: { mimeType: "multipart/mixed", parts } };
    const text = parseFullMessage(msg).textBody;
    expect(text).toContain("marker-0");
    expect(text).toContain("marker-3");
    expect(text).not.toContain("marker-4");
    expect(text).not.toContain("marker-9");
  });

  it("converts deeply nested HTML quickly and without throwing", () => {
    for (const unit of ["div", "ul><li", "table><tr><td"]) {
      const closing = unit.split("><").reverse().join("></");
      const html =
        `<${unit}>`.repeat(30_000) + "Interview on Friday" + `</${closing}>`.repeat(30_000);
      const started = Date.now();
      const msg: gmail_v1.Schema$Message = {
        payload: { mimeType: "text/html", body: { data: b64(html) } },
      };
      expect(() => parseFullMessage(msg)).not.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  });

  it("caps the whole textBody at 1 MiB across many parts", () => {
    const chunk = "x".repeat(900_000);
    const parts = Array.from({ length: 50 }, () => ({
      mimeType: "text/plain",
      body: { data: b64(chunk) },
    }));
    const msg: gmail_v1.Schema$Message = { payload: { mimeType: "multipart/mixed", parts } };
    expect(parseFullMessage(msg).textBody.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("stays fast on adversarial address headers", () => {
    const headers = (name: string, value: string): gmail_v1.Schema$Message => ({
      payload: { mimeType: "text/plain", headers: [{ name, value }], body: { data: b64("x") } },
    });
    const started = Date.now();
    parseFullMessage(headers("To", " ".repeat(500_000)));
    parseFullMessage(headers("To", "(".repeat(500_000)));
    parseFullMessage(headers("From", "(".repeat(500_000) + " <a@b.example>"));
    parseFullMessage(headers("Cc", "x ".repeat(500_000)));
    parseFullMessage(headers("Subject", "=?" + "a".repeat(500_000)));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("parseAddressList", () => {
  it("parses '\"Ana Pérez\" <ana@x.example>, b@y.example'", () => {
    expect(parseAddressList('"Ana Pérez" <ana@x.example>, b@y.example')).toEqual([
      { name: "Ana Pérez", email: "ana@x.example" },
      { name: null, email: "b@y.example" },
    ]);
  });

  it("keeps commas inside quoted names and lowercases addresses", () => {
    expect(parseAddressList('"Ruiz, Ana" <Ana@Quarry.Example>; Lee <lee@y.example>')).toEqual([
      { name: "Ruiz, Ana", email: "ana@quarry.example" },
      { name: "Lee", email: "lee@y.example" },
    ]);
  });

  it("returns an empty list for null, empty or address-less input", () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
  });

  it("stays fast on adversarial input and caps the header at 4 KiB", () => {
    const started = Date.now();
    parseAddressList(" ".repeat(200_000));
    parseAddressList("(".repeat(200_000));
    parseAddressList("<".repeat(200_000));
    parseAddressList('"'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1_000);

    const many = Array.from({ length: 2_000 }, (_, i) => `u${i}@y.example`).join(", ");
    const parsed = parseAddressList(many);
    expect(parsed.length).toBeGreaterThan(100);
    expect(parsed.length).toBeLessThan(2_000);
    // the last kept address is whole, not cut in the middle
    expect(parsed.at(-1)?.email).toMatch(/^u\d+@y\.example$/);
  });

  it("drops a group label and a comment", () => {
    expect(parseAddressList("Team: a@x.example, b@y.example;")).toEqual([
      { name: null, email: "a@x.example" },
      { name: null, email: "b@y.example" },
    ]);
    expect(parseAddressList("c@z.example (Ana, Quarry)")).toEqual([
      { name: null, email: "c@z.example" },
    ]);
  });
});

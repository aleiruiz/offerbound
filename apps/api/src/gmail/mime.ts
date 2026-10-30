import type { gmail_v1 } from "@googleapis/gmail";
import { convert } from "html-to-text";
import type { IcsEvent, ParsedHeaders, ParsedMessage } from "@offerbound/contracts";
import { parseIcs } from "./ics.js";

/** TECHNICAL_SPEC §5.5 step 1: calendar parts and .ics attachments larger than this are ignored. */
export const MAX_ICS_BYTES = 256 * 1024;

/** A text/plain part is read up to this many bytes; the rest of an oversized part is dropped. */
const MAX_TEXT_PART_BYTES = 1024 * 1024;

/**
 * html-to-text costs far more than linear time on deeply nested markup, so HTML is cut much
 * lower. The stored body is capped at 15,000 characters anyway.
 */
const MAX_HTML_BYTES = 128 * 1024;

/**
 * Total HTML input read across all parts of one message. The 1 MiB cap on output text does not
 * bound the work, since many parts that convert to little text would each be converted; once
 * this budget is spent no further HTML part is decoded or converted.
 */
const MAX_HTML_BUDGET_BYTES = 512 * 1024;

/** Cap on the whole textBody, however many parts contribute. */
const MAX_TEXT_BODY_CHARS = 1024 * 1024;

/** Limits on the MIME tree itself; email is untrusted input. */
const MAX_MIME_DEPTH = 20;
const MAX_MIME_PARTS = 500;
const MAX_ICS_EVENTS = 50;

type Part = gmail_v1.Schema$MessagePart;

// ---------------------------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------------------------

/** Header values are cut to this many characters before any parsing (the work stays linear). */
const MAX_HEADER_CHARS = 4096;

function headerValues(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (const header of headers ?? []) {
    if (header.name?.toLowerCase() === wanted && typeof header.value === "string") {
      values.push(header.value.slice(0, MAX_HEADER_CHARS));
    }
  }
  return values;
}

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | null {
  return headerValues(headers, name)[0] ?? null;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Decode RFC 2047 encoded words ("=?UTF-8?B?...?=") in a header value. */
function decodeMimeWords(value: string): string {
  const withoutGaps = value.replace(/(\?=)\s+(?==\?)/g, "$1");
  return withoutGaps.replace(
    /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g,
    (whole, charset: string, encoding: string, text: string) => {
      const label = charset.split("*")[0] ?? "utf-8";
      let bytes: Uint8Array;
      if (encoding.toLowerCase() === "b") {
        bytes = Buffer.from(text, "base64");
      } else {
        bytes = decodeQuotedPrintable(Buffer.from(text.replace(/_/g, " "), "latin1"));
      }
      try {
        return new TextDecoder(label).decode(bytes);
      } catch {
        return whole;
      }
    },
  );
}

const EMAIL_SHAPE = /^[^\s<>@,;:"()]+@[^\s<>@,;:"()]+$/;

function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i] ?? "";
    if (inQuote) {
      current += ch;
      if (ch === "\\" && i + 1 < list.length) {
        current += list[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === "(") paren += 1;
    else if (ch === ")" && paren > 0) paren -= 1;
    if ((ch === "," || ch === ";") && angle === 0 && paren === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function cleanName(raw: string): string | null {
  let name = raw.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  name = decodeMimeWords(name).trim();
  return name === "" ? null : name;
}

/** Keep at most MAX_HEADER_CHARS, ending on a separator so the last address is not half-read. */
function capAddressHeader(header: string): string {
  if (header.length <= MAX_HEADER_CHARS) return header;
  const head = header.slice(0, MAX_HEADER_CHARS);
  const lastSeparator = Math.max(head.lastIndexOf(","), head.lastIndexOf(";"));
  return lastSeparator > 0 ? head.slice(0, lastSeparator) : head;
}

/** Drop a group label such as "Team:" that precedes the first address of a group. */
function stripGroupLabel(token: string): string {
  const colon = token.indexOf(":");
  if (colon === -1 || token.charAt(colon + 1) === "/") return token;
  if (/[<>"@]/.test(token.slice(0, colon))) return token;
  return token.slice(colon + 1);
}

/** Remove "(comment)" runs; an unclosed "(" is left alone. Linear in the input. */
function stripComments(token: string): string {
  let out = "";
  let position = 0;
  for (;;) {
    const open = token.indexOf("(", position);
    const close = open === -1 ? -1 : token.indexOf(")", open + 1);
    if (close === -1) return out + token.slice(position);
    out += token.slice(position, open);
    position = close + 1;
  }
}

/** Parse an address header ("Name <a@x.example>, b@y.example") into names and lowercase addresses. */
export function parseAddressList(header: string | null): { name: string | null; email: string }[] {
  if (header === null || header.trim() === "") return [];
  const result: { name: string | null; email: string }[] = [];
  for (const rawToken of splitTopLevel(capAddressHeader(header))) {
    const token = stripGroupLabel(rawToken).trim();
    if (token === "") continue;
    const open = token.lastIndexOf("<");
    const close = token.indexOf(">", open + 1);
    let email: string;
    let name: string | null;
    if (open !== -1 && close !== -1) {
      email = token.slice(open + 1, close).trim();
      name = cleanName(token.slice(0, open));
    } else {
      email = stripComments(token).trim().replace(/^"|"$/g, "");
      name = null;
    }
    if (!EMAIL_SHAPE.test(email)) continue;
    email = email.toLowerCase();
    result.push({ name: name === email ? null : name, email });
  }
  return result;
}

/** Parse the headers of a Gmail message (format=metadata or full) into the shared shape. */
export function parseMessageHeaders(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): ParsedHeaders {
  const from = headerValue(headers, "From");
  const sender = parseAddressList(from)[0];
  const emails = (name: string): string[] =>
    parseAddressList(headerValues(headers, name).join(", ")).map((a) => a.email);
  const subject = headerValue(headers, "Subject");
  return {
    from: from === null ? null : decodeMimeWords(from),
    fromName: sender?.name ?? null,
    fromEmail: sender?.email ?? null,
    to: emails("To"),
    cc: emails("Cc"),
    subject: subject === null ? null : decodeMimeWords(subject),
    date: headerValue(headers, "Date"),
    listId: headerValue(headers, "List-Id"),
  };
}

// ---------------------------------------------------------------------------------------------
// Part bodies
// ---------------------------------------------------------------------------------------------

function decodeQuotedPrintable(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const hex = (b: number | undefined): number => {
    if (b === undefined) return -1;
    if (b >= 0x30 && b <= 0x39) return b - 0x30;
    if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
    if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
    return -1;
  };
  for (let i = 0; i < input.length; i++) {
    const b = input[i] as number;
    if (b !== 0x3d) {
      out.push(b);
      continue;
    }
    const next = input[i + 1];
    if (next === 0x0d && input[i + 2] === 0x0a) {
      i += 2; // soft line break
    } else if (next === 0x0a) {
      i += 1;
    } else if (hex(next) >= 0 && hex(input[i + 2]) >= 0) {
      out.push(hex(next) * 16 + hex(input[i + 2]));
      i += 2;
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Gmail normally hands back parts already stripped of their transfer encoding while the part
 * header still says "quoted-printable". Decoding such text would corrupt it ("?jobId=12345"
 * would turn "=12" into a control byte), so decode only on positive evidence of undecoded
 * quoted-printable: pure ASCII in which every "=" is a valid escape or soft line break, no
 * escape produces a control byte, and at least one soft line break, "=3D" or high-byte escape
 * ("=80" to "=FF") is present. Real encoders always write "=" as "=3D" and non-ASCII as escapes.
 */
function looksQuotedPrintable(bytes: Uint8Array): boolean {
  const hex = (b: number | undefined): number => {
    if (b === undefined) return -1;
    if (b >= 0x30 && b <= 0x39) return b - 0x30;
    if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
    if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
    return -1;
  };
  let evidence = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b > 0x7f) return false;
    if (b !== 0x3d) continue;
    const next = bytes[i + 1];
    if (next === 0x0a || (next === 0x0d && bytes[i + 2] === 0x0a)) {
      evidence = true; // soft line break
      continue;
    }
    if (next === undefined) continue; // trailing "=" at the very end
    const high = hex(next);
    const low = hex(bytes[i + 2]);
    if (high < 0 || low < 0) return false;
    const value = high * 16 + low;
    if (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d) return false;
    // Encoders write uppercase hex; a lowercase "=ab" in a URL is far more likely literal.
    const upper = (b: number | undefined): boolean => b !== undefined && !(b >= 0x61 && b <= 0x66);
    if ((value === 0x3d || value >= 0x80) && upper(next) && upper(bytes[i + 2])) evidence = true;
  }
  return evidence;
}

function charsetOf(part: Part): string {
  const contentType = headerValue(part.headers, "Content-Type") ?? "";
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1] ?? "utf-8";
}

function rawBytes(part: Part, maxBytes: number): Uint8Array | null {
  const data = part.body?.data;
  if (typeof data !== "string" || data === "") return null;
  // base64url expands 3 bytes into 4 characters; skip decoding anything clearly over the limit.
  if (data.length > Math.ceil((maxBytes * 4) / 3) + 8) return null;
  return Buffer.from(data, "base64url");
}

function isUtf8(charset: string): boolean {
  return /^utf-?8$/i.test(charset);
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodeText(part: Part, maxBytes: number): string {
  const data = part.body?.data;
  if (typeof data !== "string" || data === "") return "";
  const head = Buffer.from(data.slice(0, Math.ceil((maxBytes * 4) / 3)), "base64url").subarray(
    0,
    maxBytes,
  );
  let bytes: Uint8Array = head;
  const encoding = (headerValue(part.headers, "Content-Transfer-Encoding") ?? "")
    .trim()
    .toLowerCase();
  if (encoding === "quoted-printable" && looksQuotedPrintable(bytes)) {
    const decoded = decodeQuotedPrintable(bytes);
    // A lone "=AB" in a UTF-8 part is a literal, not an escape: it would not be valid UTF-8.
    if (!isUtf8(charsetOf(part)) || isValidUtf8(decoded)) bytes = decoded;
  }
  return decodeCharset(bytes, charsetOf(part));
}

/** Linear tag stripper, used only if html-to-text throws. */
function crudeStripTags(html: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html.charAt(i);
    if (ch === "<") inTag = true;
    else if (ch === ">" && inTag) {
      inTag = false;
      out += " ";
    } else if (!inTag) out += ch;
  }
  return out;
}

function htmlToText(html: string): string {
  try {
    return convertHtml(html);
  } catch {
    return crudeStripTags(html);
  }
}

function convertHtml(html: string): string {
  return convert(html, {
    wordwrap: false,
    limits: { maxInputLength: MAX_HTML_BYTES, maxDepth: 50 },
    selectors: [
      { selector: "a", options: { linkBrackets: ["[", "]"], hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "head", format: "skip" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
      { selector: "table", options: { uppercaseHeaderCells: false } },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Walking the tree
// ---------------------------------------------------------------------------------------------

type Collected = { plain: string[]; html: string[]; calendars: string[] };

function isAttachment(part: Part): boolean {
  if (typeof part.filename === "string" && part.filename !== "") return true;
  const disposition = headerValue(part.headers, "Content-Disposition") ?? "";
  return /^\s*attachment/i.test(disposition);
}

/** True for a text/calendar (or application/ics) part or one named *.ics. */
export function isCalendarPart(part: Part): boolean {
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime === "text/calendar" || mime === "application/ics") return true;
  return (part.filename ?? "").toLowerCase().endsWith(".ics");
}

function collect(root: Part): Collected {
  const found: Collected = { plain: [], html: [], calendars: [] };
  let visited = 0;
  let htmlBudget = MAX_HTML_BUDGET_BYTES;
  const walk = (part: Part, depth: number): void => {
    visited += 1;
    if (visited > MAX_MIME_PARTS || depth > MAX_MIME_DEPTH) return;
    if (isCalendarPart(part)) {
      // Attachments whose bytes were not delivered inline cannot be read here.
      const declared = part.body?.size;
      if (typeof declared === "number" && declared > MAX_ICS_BYTES) return;
      const bytes = rawBytes(part, MAX_ICS_BYTES);
      if (bytes !== null && bytes.length <= MAX_ICS_BYTES) {
        found.calendars.push(decodeCharset(bytes, charsetOf(part)));
      }
      return;
    }
    const mime = (part.mimeType ?? "").toLowerCase();
    if (mime === "text/plain" || mime === "text/html") {
      if (isAttachment(part)) return;
      if (mime === "text/plain") {
        const text = decodeText(part, MAX_TEXT_PART_BYTES);
        if (text.trim() !== "") found.plain.push(text);
      } else if (htmlBudget > 0) {
        const text = decodeText(part, Math.min(MAX_HTML_BYTES, htmlBudget));
        htmlBudget -= Buffer.byteLength(text, "utf8");
        if (text.trim() !== "") found.html.push(text);
      }
      return;
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return found;
}

/** Join parts (converting HTML ones) until the aggregate cap is reached. */
function joinBounded(parts: string[], isHtml: boolean): string {
  const pieces: string[] = [];
  let total = 0;
  for (const part of parts) {
    if (total >= MAX_TEXT_BODY_CHARS) break;
    const text = isHtml ? htmlToText(part) : part;
    pieces.push(text);
    total += text.length + 2;
  }
  return pieces.join("\n\n").slice(0, MAX_TEXT_BODY_CHARS);
}

function dedupeEvents(events: IcsEvent[]): IcsEvent[] {
  const seen = new Set<string>();
  const out: IcsEvent[] = [];
  for (const event of events) {
    const key = JSON.stringify([event.uid, event.method, event.start, event.end]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
    if (out.length >= MAX_ICS_EVENTS) break;
  }
  return out;
}

/**
 * Turn a Gmail `format=full` message into headers, plain text and calendar events.
 *
 * `textBody` is the text/plain part when there is one, else the text/html part converted to
 * text with links written as "text [url]". It is not yet de-quoted (see stripQuotedHistory).
 * Parts whose bytes Gmail did not deliver inline (attachments with only an attachmentId) are
 * ignored; the Gmail client must inline an .ics attachment's data before calling this.
 * Never logs or renders content.
 */
export function parseFullMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const payload = msg.payload ?? {};
  const found = collect(payload);
  const textBody = joinBounded(
    found.plain.length > 0 ? found.plain : found.html,
    !found.plain.length,
  );
  const icsEvents = dedupeEvents(found.calendars.flatMap((text) => parseIcs(text)));
  return { headers: parseMessageHeaders(payload.headers), textBody, icsEvents };
}

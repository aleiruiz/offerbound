/** TECHNICAL_SPEC §5.5 step 2: the stored and LLM-visible body is capped at this many characters. */
export const MAX_BODY_CHARS = 15_000;

/** Work on at most this much raw text; anything past it cannot matter once truncated. */
const MAX_INPUT_CHARS = 1_000_000;

/** Attribution lines are short; longer lines are prose and are never tested against the patterns. */
const MAX_ATTRIBUTION_CHARS = 400;

const ATTRIBUTION_EN = /^On .+ wrote:$/;
const ATTRIBUTION_ES = /^El .+ (?:escribió|ha escrito):$/;
const ORIGINAL_MESSAGE = /^-----Original Message-----/;
const FROM_HEADER = /^From: .+/;

function startsAttribution(line: string, next: string | undefined): boolean {
  const first = line.trim();
  if (first.length > MAX_ATTRIBUTION_CHARS) return false;
  const isEn = first.startsWith("On ");
  const isEs = first.startsWith("El ");
  if (!isEn && !isEs) return false;
  const pattern = isEn ? ATTRIBUTION_EN : ATTRIBUTION_ES;
  if (pattern.test(first)) return true;
  // Mail clients wrap long attribution lines onto a second line.
  if (next !== undefined) {
    const joined = `${first} ${next.trim()}`;
    return joined.length <= MAX_ATTRIBUTION_CHARS && pattern.test(joined);
  }
  return false;
}

function cutIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (startsAttribution(line, lines[i + 1])) return i;
    if (ORIGINAL_MESSAGE.test(trimmed)) return i;
    if (trimmed.startsWith(">")) return i;
    if (i > 0 && (lines[i - 1] ?? "").trim() === "" && FROM_HEADER.test(trimmed)) return i;
  }
  return lines.length;
}

/** Zero-width characters and the byte order mark, common in HTML email. */
const INVISIBLE = new RegExp("[\\u200b-\\u200d\\u2060\\ufeff]", "g");

function collapseWhitespace(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(INVISIBLE, "")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  // Do not leave the first half of a surrogate pair at the end.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Remove quoted history from an email body, collapse whitespace and cap the length.
 *
 * Cuts everything from the first reply attribution ("On … wrote:", "El … escribió:" or
 * "ha escrito:"), "-----Original Message-----" line, "From: …" line that follows a blank
 * line, or line starting with ">" (TECHNICAL_SPEC §5.5 step 2).
 */
export function stripQuotedHistory(text: string): string {
  const normalized = text.slice(0, MAX_INPUT_CHARS).replace(/\r\n?/g, "\n");
  const lines = normalized.replace(/^\s*\n/, "").split("\n");
  const kept = lines.slice(0, cutIndex(lines));
  return truncate(collapseWhitespace(kept.join("\n")), MAX_BODY_CHARS);
}

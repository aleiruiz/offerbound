/** True for absolute `http:` and `https:` URLs only (SECURITY §10). */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export type TextPart =
  { type: "text"; text: string } | { type: "link"; href: string; text: string };

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}>]+$/;

/**
 * Splits plain text into text and link parts. Only `http(s)` URLs become links; trailing
 * punctuation stays outside the link. Anything else, including `javascript:` and `data:`, stays text.
 */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const url = raw.replace(TRAILING, "");
    if (!isHttpUrl(url)) continue;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    parts.push({ type: "link", href: url, text: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

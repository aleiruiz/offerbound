/**
 * jsdom has no layout, so `window.matchMedia` is replaced by a small evaluator that understands
 * `min-width`, `max-width`, `prefers-color-scheme` and `prefers-reduced-motion`.
 * MUI's `useMediaQuery(theme.breakpoints.up("md"))` then follows the width chosen by the test.
 */
export interface Viewport {
  width: number;
  dark?: boolean;
  reducedMotion?: boolean;
}

function evaluate(query: string, vp: Viewport): boolean {
  const cleaned = query.replace(/^@media\s*/, "");
  return cleaned.split(/\s+and\s+/).every((part) => {
    const m = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/.exec(part.trim());
    if (!m) return false;
    const [, feature, value] = m;
    const number = parseFloat(value ?? "");
    if (feature === "min-width") return vp.width >= number;
    if (feature === "max-width") return vp.width <= number;
    if (feature === "prefers-color-scheme") return (value === "dark") === Boolean(vp.dark);
    if (feature === "prefers-reduced-motion")
      return value === "reduce" && Boolean(vp.reducedMotion);
    return false;
  });
}

export function setViewport(vp: Viewport): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: evaluate(query, vp),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

import { fireEvent } from "@testing-library/react";
import { it } from "vitest";

/**
 * Per-test timeout for the few tests that are heavy under jsdom: a dialog with several MUI fields,
 * or a page that re-renders its whole table on every click. Alone they take 2 to 4 s; on a busy CI
 * runner that can pass vitest's 5 s default, so they get room instead of a flake.
 */
export const HEAVY_TEST_MS = 20_000;

/** `it` with `HEAVY_TEST_MS`. Use it on those specific tests only, never as the default. */
export function heavyIt(name: string, fn: () => Promise<void>): void {
  it(name, { timeout: HEAVY_TEST_MS }, fn);
}

/**
 * Sets a field's value in one change event. Typing or pasting through userEvent costs about 200 ms
 * per field under MUI, and the page cannot tell the two apart. Keep `user.type` for a test that is
 * about typing itself (a debounce, say).
 */
export function setValue(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
}

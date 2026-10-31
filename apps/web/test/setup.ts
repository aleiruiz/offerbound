import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { setLocale } from "../src/i18n";

afterEach(() => {
  cleanup();
  setLocale("en");
  vi.unstubAllGlobals();
  try {
    window.localStorage.clear();
  } catch {
    // storage unavailable in this environment; nothing to clear
  }
});

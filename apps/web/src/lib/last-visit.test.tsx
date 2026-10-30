import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEADS_SEEN_KEY, isFoundSince, readLeadsSeenAt, useLeadsSince } from "./last-visit";

const PREVIOUS = "2026-10-28T12:00:00.000Z";
const NOW = new Date("2026-10-29T18:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readLeadsSeenAt", () => {
  it("is null with nothing stored, or something that is not a time", () => {
    expect(readLeadsSeenAt()).toBeNull();
    window.localStorage.setItem(LEADS_SEEN_KEY, "yesterday-ish");
    expect(readLeadsSeenAt()).toBeNull();
  });

  it("reads the stored time", () => {
    window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
    expect(readLeadsSeenAt()).toBe(Date.parse(PREVIOUS));
  });

  it("is null when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readLeadsSeenAt()).toBeNull();
  });
});

describe("isFoundSince", () => {
  it("is true only for a lead found after the mark, and never without one", () => {
    const since = Date.parse(PREVIOUS);
    expect(isFoundSince("2026-10-28T12:00:01Z", since)).toBe(true);
    expect(isFoundSince(PREVIOUS, since)).toBe(false);
    expect(isFoundSince("2026-10-27T09:00:00Z", since)).toBe(false);
    expect(isFoundSince("2026-10-29T09:00:00Z", null)).toBe(false);
  });
});

describe("useLeadsSince", () => {
  it("keeps the mark fixed for the visit and stores the current time when marking", () => {
    window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
    const { result, rerender } = renderHook(() => useLeadsSince({ markSeen: true }));
    expect(result.current).toBe(Date.parse(PREVIOUS));
    expect(window.localStorage.getItem(LEADS_SEEN_KEY)).toBe(NOW.toISOString());
    vi.setSystemTime(new Date("2026-10-29T19:00:00Z"));
    rerender();
    expect(result.current).toBe(Date.parse(PREVIOUS));
  });

  it("only reads when not marking", () => {
    window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
    const { result } = renderHook(() => useLeadsSince({ markSeen: false }));
    expect(result.current).toBe(Date.parse(PREVIOUS));
    expect(window.localStorage.getItem(LEADS_SEEN_KEY)).toBe(PREVIOUS);
  });

  it("does not crash when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useLeadsSince({ markSeen: true }));
    expect(result.current).toBeNull();
  });
});

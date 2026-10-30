import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectMovement, MOVEMENT_VISIBLE_MS, usePipelineMovement } from "./pipeline-movement";

describe("detectMovement", () => {
  it("finds exactly one application that changed stage", () => {
    expect(detectMovement({ applied: 3, screening: 1 }, { applied: 2, screening: 2 })).toEqual({
      from: "applied",
      to: "screening",
    });
    // A missing status counts as 0; closing an application is a movement too.
    expect(detectMovement({ interviewing: 1 }, { interviewing: 0, rejected: 1 })).toEqual({
      from: "interviewing",
      to: "rejected",
    });
  });

  it("gives nothing when the change is not a single move", () => {
    expect(detectMovement({ applied: 3 }, { applied: 3 })).toBeNull();
    // A new application, a removed one, or two moves at once.
    expect(detectMovement({ applied: 3 }, { applied: 4 })).toBeNull();
    expect(detectMovement({ applied: 3 }, { applied: 2 })).toBeNull();
    expect(
      detectMovement({ applied: 3, screening: 1 }, { applied: 1, screening: 2, assessment: 1 }),
    ).toBeNull();
    expect(
      detectMovement({ applied: 2, screening: 2 }, { applied: 1, screening: 1, offer: 2 }),
    ).toBeNull();
  });
});

describe("usePipelineMovement", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ignores the first load, reports a single move with a new key each time, then clears", () => {
    vi.useFakeTimers();
    const first = { applied: 3, screening: 1 };
    const { result, rerender } = renderHook(({ counts }) => usePipelineMovement(counts), {
      initialProps: { counts: first },
    });
    expect(result.current).toBeUndefined();

    rerender({ counts: { applied: 2, screening: 2 } });
    expect(result.current).toMatchObject({ from: "applied", to: "screening" });
    const firstKey = result.current?.key;

    rerender({ counts: { applied: 1, screening: 3 } });
    expect(result.current).toMatchObject({ from: "applied", to: "screening" });
    expect(result.current?.key).not.toBe(firstKey);

    act(() => {
      vi.advanceTimersByTime(MOVEMENT_VISIBLE_MS);
    });
    expect(result.current).toBeUndefined();
  });

  it("does not animate while the tab is hidden", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { result, rerender } = renderHook(({ counts }) => usePipelineMovement(counts), {
      initialProps: { counts: { applied: 3, screening: 1 } },
    });
    rerender({ counts: { applied: 2, screening: 2 } });
    expect(result.current).toBeUndefined();
  });
});

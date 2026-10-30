import type { ApplicationStatus } from "@offerbound/contracts";
import { useEffect, useRef, useState } from "react";

export type StatusCounts = Partial<Record<ApplicationStatus, number>>;

export interface PipelineMovement {
  from: ApplicationStatus;
  to: ApplicationStatus;
  /** Different for every movement, so the marker restarts at its own `from` stop each time. */
  key: string;
}

/**
 * The movement between two sets of counts when exactly one application changed stage: one status
 * lost one, one status gained one and nothing else moved. Anything else (several moves, a new
 * application, a deletion) cannot be told apart from noise and gives null.
 */
export function detectMovement(
  before: StatusCounts,
  after: StatusCounts,
): { from: ApplicationStatus; to: ApplicationStatus } | null {
  const statuses = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ]) as Set<ApplicationStatus>;
  let from: ApplicationStatus | null = null;
  let to: ApplicationStatus | null = null;
  for (const status of statuses) {
    const delta = (after[status] ?? 0) - (before[status] ?? 0);
    if (delta === 0) continue;
    if (delta === -1 && from === null) from = status;
    else if (delta === 1 && to === null) to = status;
    else return null;
  }
  return from !== null && to !== null ? { from, to } : null;
}

/** How long the marker stays on the line after it has moved. */
export const MOVEMENT_VISIBLE_MS = 5000;

/**
 * Watches the pipeline counts of each poll. When exactly one application moved between stages
 * while the tab is visible, returns the movement for `PipelineRoute` (DESIGN_SPEC §8); it clears
 * itself after a few seconds. The first load never counts as a movement.
 */
export function usePipelineMovement(
  counts: StatusCounts | undefined,
): PipelineMovement | undefined {
  const previous = useRef<StatusCounts | undefined>(undefined);
  const serial = useRef(0);
  const [movement, setMovement] = useState<PipelineMovement | undefined>(undefined);

  useEffect(() => {
    if (!counts) return;
    const before = previous.current;
    previous.current = counts;
    if (!before || before === counts) return;
    const moved = document.visibilityState === "hidden" ? null : detectMovement(before, counts);
    if (moved) {
      serial.current += 1;
      setMovement({ ...moved, key: `${moved.from}>${moved.to}#${serial.current}` });
    }
  }, [counts]);

  useEffect(() => {
    if (!movement) return;
    const timer = setTimeout(() => setMovement(undefined), MOVEMENT_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [movement]);

  return movement;
}

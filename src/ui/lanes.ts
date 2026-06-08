import { LANES } from "../model.js";
import type { Lane } from "../model.js";

/** A card that carries the lane it belongs in (both PRD and Issue qualify). */
interface Laned {
  readonly lane: Lane;
}

/**
 * Bucket cards into their lanes, preserving the order the scanner produced.
 * Shared by the board- and Issue-level kanbans so both lay out identically.
 */
export function groupByLane<T extends Laned>(cards: readonly T[]): Record<Lane, T[]> {
  const byLane = Object.fromEntries(
    LANES.map((lane) => [lane, [] as T[]]),
  ) as Record<Lane, T[]>;

  for (const card of cards) {
    byLane[card.lane].push(card);
  }
  return byLane;
}

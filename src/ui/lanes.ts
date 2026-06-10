import { ISSUE_LANES } from "../model.js";
import type { Lane } from "../model.js";

/** A card that carries the lane it belongs in (both PRD and Issue qualify). */
interface Laned {
  readonly lane: Lane;
}

/**
 * Bucket cards into lanes, preserving the order the scanner produced. Seeds a
 * bucket for every Issue-level lane (the superset); the board-level kanban reads
 * only its three derived lanes back out, which are a subset, so this serves both.
 */
export function groupByLane<T extends Laned>(cards: readonly T[]): Record<Lane, T[]> {
  const byLane = Object.fromEntries(
    ISSUE_LANES.map((lane) => [lane, [] as T[]]),
  ) as Record<Lane, T[]>;

  for (const card of cards) {
    byLane[card.lane].push(card);
  }
  return byLane;
}

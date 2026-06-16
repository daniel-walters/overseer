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

/**
 * The lane shape — the per-lane card counts, in the given lanes' render order —
 * that the pure nav reducer's `move` action consumes (ADR 0015). This is the one
 * piece of Board-derived data the reducer needs to know the grid's geometry; it
 * stays here (the render side) so the reducer never imports the Board. Serves
 * both levels: pass `BOARD_LANES` for the 3-column board, `ISSUE_LANES` for the
 * 7-column Issue level.
 */
export function laneShape<T extends Laned>(
  cards: readonly T[],
  lanes: readonly Lane[],
): number[] {
  const byLane = groupByLane(cards);
  return lanes.map((lane) => byLane[lane].length);
}

/**
 * The card at a `(laneIndex, rowIndex)` grid coordinate, resolved against the
 * given lanes' render order, or `undefined` if the coordinate rests on no card.
 * The renderer selects by this coordinate instead of by a flat-index-derived id
 * (ADR 0015) — the inverse of {@link laneShape}: shape feeds the reducer, this
 * turns the reducer's coordinate back into a concrete card.
 */
export function cardAtCoord<T extends Laned>(
  cards: readonly T[],
  lanes: readonly Lane[],
  coord: { readonly laneIndex: number; readonly rowIndex: number } | undefined,
): T | undefined {
  if (!coord) return undefined;
  const lane = lanes[coord.laneIndex];
  if (lane === undefined) return undefined;
  return groupByLane(cards)[lane][coord.rowIndex];
}

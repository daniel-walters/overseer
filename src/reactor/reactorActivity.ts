/**
 * The board-level reactor-activity signal — whether the Reactor is actively
 * spawning (**working**), on but with nothing eligible (**idle**), or quiesced
 * because auto-run is off (**at-rest**).
 *
 * It is the second surfaced reactor-state overlay, the board-level companion to
 * the per-card `⊘ suppressed` marker (CONTEXT.md → Reactor → Visibility; ADR
 * 0011). The pair closes the "visually invisible Reactor" gap from opposite ends:
 * the suppressed marker says *this card is being ignored*, this signal says
 * *whether the Reactor as a whole is doing anything*. Like every overlay it is
 * derived from in-memory state and never written to the watched root (ADR 0002).
 *
 * It is deliberately distinct from the auto-run on/off indicator. Auto-run
 * on/off answers "is the brake released?"; this answers "given the brake is
 * released, is the Reactor moving?" — because an idle on-Reactor and an off one
 * both leave the board still, and only this signal tells the two apart.
 */
export type ReactorActivity = "working" | "idle" | "at-rest";

/** The two pieces of in-memory reactor state {@link deriveActivity} reads. */
export interface ReactorActivityState {
  /** Whether auto-run is on (the Reactor will reconcile and spawn). */
  readonly enabled: boolean;
  /** Whether the most recent reconcile spawned at least one agent. */
  readonly spawnedLastReconcile: boolean;
}

/**
 * Derive the board-level {@link ReactorActivity} from the Reactor's in-memory
 * state. Auto-run off is **at-rest** unconditionally — the Reactor starts nothing
 * while braked, so its stillness is expected, never reported as idle/working even
 * if the last (enabled) reconcile had spawned. With auto-run on, the signal turns
 * on whether the last reconcile spawned: **working** if it did, **idle** if it
 * found nothing eligible. Pure and total: a plain mapping over two booleans.
 */
export function deriveActivity(state: ReactorActivityState): ReactorActivity {
  if (!state.enabled) return "at-rest";
  return state.spawnedLastReconcile ? "working" : "idle";
}

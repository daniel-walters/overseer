# The review reactor runs in-process, only while the board is open

## Status

accepted

## Context

The review flow can be triggered two ways: a keybind (the user selects and confirms, mirroring the `d` dispatch) or a **reactor** that watches the board and auto-spawns reviewers for Issues sitting in `ready-for-review`. The reactor could live inside the Ink process (hooked to the watcher subscription that already rebuilds the board on every filesystem event) or as a standalone headless daemon.

## Decision

If/when we build the reactor, it runs **in-process** — as a side-effect appended to the existing watcher→re-scan callback — and therefore only while the board (the Ink TUI) is open. We will **not** build a standalone daemon. Because Overseer is level-triggered (it re-scans the whole root and rebuilds from scratch, never diffing), the reactor needs no transition detection: on each re-scan it reconciles the `ready-for-review` frontier and the flip-before-spawn guard (`ready-for-review → in-review`) provides idempotency, exactly as dispatch does.

The keybind version ships first; the reactor is a strictly additive layer over the same review spawn edge (frontier classifier, reviewer prompt, flip+spawn runner).

## Consequences

- **Automation pauses when the board is closed.** Work that reached `ready-for-review` while the TUI was down is reconciled on next open — accepted, not a bug.
- The reactor forces a **terminal-failure state** the keybind can punt on: an automated rollback to `ready-for-review` (or `ready-for-agent`) would otherwise be re-picked-up on the next reconcile and retry forever. The keybind punts because a human simply doesn't press the key again; the reactor needs an explicit terminal status so a failed spawn is not retried indefinitely.
- **No spawn cap.** An earlier draft asserted the reactor "forces a spawn cap (no human consents to each unattended wave)." On reflection it does not: total reactor spawns are **bounded by the PRD's Issue count** — every spawn consumes the `ready-*` status that made the Issue eligible, and flip-before-spawn (`ready-for-agent → in-progress`, `ready-for-review → in-review`) prevents re-pickup, so there is no cycle that re-spawns the same Issue. The only unbounded-retry path is terminal-failure, addressed above. What remains is **burst width** (a wide PRD fanning out many agents on one reconcile) — but that is identical to what `d` already produces dispatching a wide frontier, and is accepted, not capped.

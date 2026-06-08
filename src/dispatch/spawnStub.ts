import type { DispatchIssue } from "./reader.js";

/**
 * The stubbed spawn tip for the tracer-bullet dispatch slice (issue #17).
 *
 * The real spawn tip — validate the repo, ensure the PRD feature branch, shell
 * out to `claude --bg --permission-mode auto`, roll back + log on failure —
 * lands in a later issue. Until then this no-op stands in its place so the whole
 * keypress → frontier → status-flip → live-board path runs end to end without
 * launching real agents. The dispatcher has already flipped the Issue to
 * `in-progress` by the time this is called, so the card has already moved.
 */
export function spawnStub(_issue: DispatchIssue): void {
  // Intentionally does nothing yet: no real agent is spawned this iteration.
}

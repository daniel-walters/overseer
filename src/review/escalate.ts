import { writeHumanReview } from "../issueFile.js";

/**
 * Escalate a `ready-for-review` Issue to `human-review` for **non-convergence**:
 * the AI-review loop ran `cap` passes without a clean pass, so the Reactor — which
 * owns the loop and the pass count (ADR 0018) — routes the Issue to a human rather
 * than spawning a `cap+1`th pass. This is the same escalation the reviewer agent
 * used to make in-process when it counted passes in its own head; moving the count
 * into Overseer's sidecar moves the escalation here, where Overseer can enforce it
 * reliably from a count it (not an agent) wrote.
 *
 * One write sets `status: human-review`, `human_review_reason: non-convergence`,
 * and a `human_review_note` carrying the pass tally so the human reading the card
 * knows *why* it escalated and how much road the review had — exactly the prose the
 * agent's own human-review exit records for the other two reasons (deviation,
 * conflict). The `completed`/`cap` numbers are folded into the note so the
 * escalation is self-explanatory without opening the sidecar.
 *
 * Best-effort and total: it runs inside the watcher callback (the Reactor) and the
 * Ink input handler (the manual `r` edge), neither of which wraps it in a
 * try/catch, so a vanished Issue file (raced a deletion) must not throw out and
 * crash the board. A failed write simply leaves the Issue `ready-for-review`; the
 * next reconcile re-evaluates it against the same cap and re-attempts the
 * escalation.
 */
export function escalateNonConvergence(
  path: string,
  completed: number,
  cap: number,
): void {
  try {
    writeHumanReview(
      path,
      "non-convergence",
      `The AI review did not converge: ${completed} of ${cap} passes still ` +
        `reported findings, so the loop reached its cap without a clean pass. ` +
        `Resolve the outstanding findings by hand, then run the merge skill.`,
    );
  } catch {
    // The Issue file vanished from the watched root between the sweep and this
    // write. Nothing to escalate; the next reconcile re-evaluates it.
  }
}

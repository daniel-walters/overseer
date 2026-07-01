import { hasValue, writeHumanReview } from "../issueFile.js";

/**
 * Escalate a non-converged `ready-for-review` Issue to `human-review`: the
 * AI-review loop ran `cap` passes without a clean pass, so the Reactor — which
 * owns the loop and the pass count (ADR 0018) — routes the Issue to a human rather
 * than spawning a `cap+1`th pass. This is the same escalation the reviewer agent
 * used to make in-process when it counted passes in its own head; moving the count
 * into Overseer's sidecar moves the escalation here, where Overseer can enforce it
 * reliably from a count it (not an agent) wrote.
 *
 * **Deviation takes precedence (ADR 0026).** The auditor records a `deviation`
 * *before* review begins, so the field is already present at this escalation
 * point. A present deviation is the more important cause for the human to see, and
 * making it win here is what keeps the three `human_review_reason` values mutually
 * exclusive: `non-convergence` is written *only* when there is no deviation. So a
 * recorded deviation escalates with reason `deviation` — its note quotes the
 * deviation and names the secondary cause (review also did not converge) — and the
 * `non-convergence` write is reached only for a non-deviating Issue.
 *
 * Either write sets `status: human-review`, `human_review_reason`, and a
 * `human_review_note` carrying the pass tally so the human reading the card knows
 * *why* it escalated and how much road the review had — the same self-explanatory
 * prose the agent's own human-review exit records for the other reasons. The
 * `completed`/`cap` numbers are folded into the note so the escalation is
 * self-explanatory without opening the sidecar.
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
  deviation?: string,
): void {
  try {
    if (hasValue(deviation)) {
      writeHumanReview(path, "deviation", deviationNote(deviation, completed, cap));
      return;
    }
    writeHumanReview(path, "non-convergence", nonConvergenceNote(completed, cap));
  } catch {
    // The Issue file vanished from the watched root between the sweep and this
    // write. Nothing to escalate; the next reconcile re-evaluates it.
  }
}

/**
 * The `human_review_note` for the non-convergence escalation: the pass tally and
 * the next human step, so the human reads why it escalated off the card.
 */
function nonConvergenceNote(completed: number, cap: number): string {
  return (
    `The AI review did not converge: ${completed} of ${cap} passes still ` +
    `reported findings, so the loop reached its cap without a clean pass. ` +
    `Resolve the outstanding findings by hand, then run the merge skill.`
  );
}

/**
 * The `human_review_note` for a deviation that *also* failed to converge: quote
 * the recorded deviation (the primary, surfaced reason) and name the secondary
 * cause (review reached its cap without converging) with the pass tally, so the
 * human reads one coherent reason without opening the sidecar.
 */
function deviationNote(deviation: string, completed: number, cap: number): string {
  return (
    `The auditor recorded a deviation from the planned approach: "${deviation}". ` +
    `The AI review also did not converge (${completed} of ${cap} passes still ` +
    `reported findings), but a deviation needs a human to confirm before the ` +
    `merge. Review the change against the Issue, then run the merge skill.`
  );
}

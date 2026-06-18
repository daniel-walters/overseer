import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBoard } from "./scanner.js";
import type { PRD, Issue } from "./model.js";

const boardFixture = fileURLToPath(
  new URL("./__fixtures__/board", import.meta.url),
);

function prdById(prds: readonly PRD[], id: string): PRD {
  const prd = prds.find((p) => p.id === id);
  if (!prd) throw new Error(`no PRD with id "${id}" in board`);
  return prd;
}

function issueById(issues: readonly Issue[], id: string): Issue {
  const issue = issues.find((i) => i.id === id);
  if (!issue) throw new Error(`no Issue with id "${id}"`);
  return issue;
}

describe("scanBoard", () => {
  it("treats a directory containing prd.md as a PRD, reading its title", () => {
    const board = scanBoard(boardFixture);

    const auth = prdById(board.prds, "auth-system");
    expect(auth.title).toBe("Authentication System");
  });

  it("derives a PRD's lane from its Issues — in-progress when any is in-progress or later", () => {
    const board = scanBoard(boardFixture);

    // auth-system has in-progress (and later) Issues, so it derives in-progress
    // regardless of any status field in prd.md (a PRD has no stored status).
    const auth = prdById(board.prds, "auth-system");
    expect(auth.lane).toBe("in-progress");
  });

  it("derives a PRD with no Issues to backlog, ignoring any prd.md status field", () => {
    const board = scanBoard(boardFixture);

    // billing's prd.md carries `status: ready-for-agent`, but a PRD has no
    // stored status (ADR 0003) and it has zero Issues, so it derives backlog.
    const billing = prdById(board.prds, "billing");
    expect(billing.lane).toBe("backlog");
  });

  it("ignores a directory that has no prd.md", () => {
    const board = scanBoard(boardFixture);

    expect(board.prds.map((p) => p.id)).not.toContain("not-a-prd");
  });

  it("falls back to the directory name when title frontmatter is absent", () => {
    const board = scanBoard(boardFixture);

    const prd = prdById(board.prds, "no-title-dir-name");
    expect(prd.title).toBe("no-title-dir-name");
  });

  it("does not crash the whole scan when one Issue has malformed frontmatter", () => {
    // A single Issue with invalid YAML (an unquoted ': ' in a value) must not
    // throw out of scanBoard and take down the live board on the next watch
    // event — it folds into backlog flagged malformed, and siblings still scan.
    const root = mkdtempSync(join(tmpdir(), "overseer-scan-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(join(dir, "prd.md"), "---\ntitle: Feature\nstatus: in-progress\n---\nbody\n");
    writeFileSync(
      join(dir, "001-broken.md"),
      "---\nstatus: ready-for-review\ndeviation: Used a cache: it is faster\n---\nbody\n",
    );
    writeFileSync(join(dir, "002-ok.md"), "---\ntitle: OK\nstatus: done\n---\nbody\n");

    let board!: ReturnType<typeof scanBoard>;
    expect(() => (board = scanBoard(root))).not.toThrow();

    const prd = prdById(board.prds, "feature");
    const broken = issueById(prd.issues, "001-broken.md");
    expect(broken.lane).toBe("backlog");
    expect(broken.malformedStatus).toBe(true);
    expect(issueById(prd.issues, "002-ok.md").lane).toBe("done");
  });

  it("derives a PRD to done only when it has Issues and all are done", () => {
    // A throwaway root: an all-done PRD derives done; one with a non-done Issue
    // does not. (The shared fixture has no all-done PRD.)
    const root = mkdtempSync(join(tmpdir(), "overseer-derive-"));

    const allDone = join(root, "shipped");
    mkdirSync(allDone);
    writeFileSync(join(allDone, "prd.md"), "---\ntitle: Shipped\n---\nbody\n");
    writeFileSync(join(allDone, "001-a.md"), "---\nstatus: done\n---\nbody\n");
    writeFileSync(join(allDone, "002-b.md"), "---\nstatus: done\n---\nbody\n");

    const board = scanBoard(root);
    expect(prdById(board.prds, "shipped").lane).toBe("done");
  });

  it("derives a done + Unsorted PRD to in-progress, never silently to done", () => {
    // An unknown-status Issue counts as pre-in-progress: it blocks the all-done
    // derivation, so the PRD lands in-progress, not done.
    const root = mkdtempSync(join(tmpdir(), "overseer-derive-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(join(dir, "prd.md"), "---\ntitle: Feature\n---\nbody\n");
    writeFileSync(join(dir, "001-done.md"), "---\nstatus: done\n---\nbody\n");
    writeFileSync(join(dir, "002-mystery.md"), "---\nstatus: marinating\n---\nbody\n");

    const board = scanBoard(root);
    expect(prdById(board.prds, "feature").lane).toBe("in-progress");
  });
});

describe("scanBoard Issues", () => {
  function authIssues(): readonly Issue[] {
    return prdById(scanBoard(boardFixture).prds, "auth-system").issues;
  }

  it("parses every non-prd.md markdown file as an Issue of the PRD", () => {
    const ids = authIssues().map((i) => i.id);

    expect(ids).toContain("001-password-hashing.md");
    expect(ids).toContain("003-login-form.md");
    expect(ids).not.toContain("prd.md");
  });

  it("identifies an Issue by its filename and reads its title and lane", () => {
    const issue = issueById(authIssues(), "003-login-form.md");

    expect(issue.title).toBe("Login form");
    expect(issue.lane).toBe("in-progress");
  });

  it("falls back to the filename slug when an Issue has no title frontmatter", () => {
    const issue = issueById(authIssues(), "007-session-tokens.md");

    expect(issue.title).toBe("session-tokens");
  });

  it("orders Issues within a lane by their NNN- prefix, gaps and all", () => {
    const issues = authIssues();
    const inProgress = issues
      .filter((i) => i.lane === "in-progress")
      .map((i) => i.id);

    // 003 and 007 share the in-progress lane; 004/005/etc. sit elsewhere.
    expect(inProgress).toEqual([
      "003-login-form.md",
      "007-session-tokens.md",
    ]);
  });

  it("splits ready-for-human / ready-for-agent into the ready lane plus a flag", () => {
    const issues = authIssues();

    const human = issueById(issues, "002-oauth-provider.md");
    expect(human.lane).toBe("ready");
    expect(human.readyFor).toBe("human");

    const agent = issueById(issues, "004-rate-limiting.md");
    expect(agent.lane).toBe("ready");
    expect(agent.readyFor).toBe("agent");
  });

  it("maps a ready-for-review Issue to its own lane, never folding it into ready", () => {
    const issue = issueById(authIssues(), "008-review-ready.md");

    expect(issue.lane).toBe("ready-for-review");
    // The shared `ready-for-` prefix must NOT fold it into the ready column.
    expect(issue.lane).not.toBe("ready");
    expect(issue.readyFor).toBeUndefined();
  });

  it("maps a human-review Issue to its own lane", () => {
    const issue = issueById(authIssues(), "009-needs-human.md");

    expect(issue.lane).toBe("human-review");
    expect(issue.readyFor).toBeUndefined();
  });

  it("records the escalation reason on a human-review Issue", () => {
    const issue = issueById(authIssues(), "009-needs-human.md");

    expect(issue.humanReviewReason).toBe("deviation");
  });

  it("omits an unrecognized escalation reason rather than carrying junk", () => {
    const issue = issueById(authIssues(), "010-bad-reason.md");

    expect(issue.lane).toBe("human-review");
    expect(issue.humanReviewReason).toBeUndefined();
  });

  it("ignores an escalation reason on an Issue that is not in human-review", () => {
    const issue = issueById(authIssues(), "011-reason-without-review.md");

    expect(issue.lane).toBe("backlog");
    expect(issue.humanReviewReason).toBeUndefined();
  });

  it("records the human-review note on a human-review Issue that carries one", () => {
    const issue = issueById(authIssues(), "009-needs-human.md");

    expect(issue.humanReviewNote).toBe(
      "Swapped the inline send for a queue to avoid a deadlock.",
    );
  });

  it("records the note independently of the reason — present on a non-deviation escalation", () => {
    // 012 escalates for non-convergence (not a deviation) yet still carries a
    // note; the note must surface regardless of which reason drives the marker.
    const issue = issueById(authIssues(), "012-stuck-with-note.md");

    expect(issue.humanReviewReason).toBe("non-convergence");
    expect(issue.humanReviewNote).toBe(
      "After 3 passes the auth test still fails intermittently; couldn't isolate the race.",
    );
  });

  it("treats a blank human-review note as absent", () => {
    const issue = issueById(authIssues(), "013-blank-note.md");

    expect(issue.lane).toBe("human-review");
    expect(issue.humanReviewNote).toBeUndefined();
  });

  it("carries no human-review note when the frontmatter omits it", () => {
    // 010 is in human-review but has no note field at all.
    const issue = issueById(authIssues(), "010-bad-reason.md");

    expect(issue.lane).toBe("human-review");
    expect(issue.humanReviewNote).toBeUndefined();
  });

  it("folds an Issue with an unrecognized status into backlog, flagged malformed", () => {
    const issue = issueById(authIssues(), "005-mystery.md");

    // The Unsorted column is gone: a missing/unknown status lands in backlog,
    // carrying the loud `malformedStatus` overlay so the data error is still
    // triaged, not silently parked as ordinary backlog.
    expect(issue.lane).toBe("backlog");
    expect(issue.malformedStatus).toBe(true);
    expect(issue.readyFor).toBeUndefined();
  });

  it("yields no Issues for a PRD whose directory holds only prd.md", () => {
    const board = scanBoard(boardFixture);

    expect(prdById(board.prds, "no-status-prd").issues).toEqual([]);
  });
});

describe("scanBoard liveness overlay", () => {
  /**
   * A throwaway root with one Issue in each of the four interesting lanes: the
   * two the overlay applies to (in-progress, in-review) and two it must never
   * touch (ready-for-agent, done). The liveness lookup is keyed by the Issue's
   * absolute path — the same `prdDir/filename` key the sidecar records (ADR 0008).
   */
  function liveRoot(): { root: string; pathOf: (file: string) => string } {
    const root = mkdtempSync(join(tmpdir(), "overseer-live-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(join(dir, "prd.md"), "---\ntitle: Feature\n---\nbody\n");
    writeFileSync(join(dir, "001-working.md"), "---\nstatus: in-progress\n---\nbody\n");
    writeFileSync(join(dir, "002-reviewing.md"), "---\nstatus: in-review\n---\nbody\n");
    writeFileSync(join(dir, "003-queued.md"), "---\nstatus: ready-for-agent\n---\nbody\n");
    writeFileSync(join(dir, "004-shipped.md"), "---\nstatus: done\n---\nbody\n");
    return { root, pathOf: (file) => join(dir, file) };
  }

  function featureIssues(board: ReturnType<typeof scanBoard>): readonly Issue[] {
    return prdById(board.prds, "feature").issues;
  }

  it("overlays a live verdict on an in-progress Issue by its absolute path", () => {
    const { root, pathOf } = liveRoot();
    const board = scanBoard(root, (path) =>
      path === pathOf("001-working.md") ? "live" : undefined,
    );

    expect(issueById(featureIssues(board), "001-working.md").liveness).toBe("live");
  });

  // ── The orphan mapping (ADR 0009) ─────────────────────────────────────────
  // The active-status gate lives here, not in the probe: the scanner is the one
  // place that knows in-progress / in-review are owned by an active agent, so it
  // maps the probe's trust-qualified absence onto the card-level verdict. The
  // load-bearing rule: `absent-clean` (a trustworthy "gone") becomes `orphaned`;
  // `absent-degraded` (an untrustworthy "gone") must stay `unknown`, never
  // `orphaned`, because a false `orphaned` invites a double-spawn.

  it("maps an absent-clean verdict on an in-progress card to orphaned", () => {
    const { root, pathOf } = liveRoot();
    const board = scanBoard(root, (path) =>
      path === pathOf("001-working.md") ? "absent-clean" : undefined,
    );

    expect(issueById(featureIssues(board), "001-working.md").liveness).toBe(
      "orphaned",
    );
  });

  it("maps an absent-clean verdict on an in-review card to orphaned", () => {
    const { root, pathOf } = liveRoot();
    const board = scanBoard(root, (path) =>
      path === pathOf("002-reviewing.md") ? "absent-clean" : undefined,
    );

    expect(issueById(featureIssues(board), "002-reviewing.md").liveness).toBe(
      "orphaned",
    );
  });

  it("maps an absent-degraded verdict to unknown, never orphaned", () => {
    // An untrustworthy query (it threw, or did not parse to an array): the agent
    // might still be alive behind the hiccup, so the card must read unknown.
    const { root, pathOf } = liveRoot();
    const board = scanBoard(root, (path) =>
      path === pathOf("001-working.md") ? "absent-degraded" : undefined,
    );

    expect(issueById(featureIssues(board), "001-working.md").liveness).toBe(
      "unknown",
    );
  });

  it("never overlays liveness on a lane that is not in-progress or in-review", () => {
    // The lookup claims every Issue is gone-clean; only the two active-agent
    // lanes may carry the marker — a ready or done card never shows a verdict, so
    // an Issue that legitimately advanced past the active status never reads
    // orphaned (ADR 0009).
    const { root } = liveRoot();
    const board = scanBoard(root, () => "absent-clean");
    const issues = featureIssues(board);

    expect(issueById(issues, "003-queued.md").liveness).toBeUndefined();
    expect(issueById(issues, "004-shipped.md").liveness).toBeUndefined();
  });

  it("leaves liveness unset when no lookup is provided", () => {
    // The default scan (board-only tests, the eager first render) carries no
    // overlay; an Issue simply has no liveness marker.
    const { root } = liveRoot();
    const issues = featureIssues(scanBoard(root));

    expect(issueById(issues, "001-working.md").liveness).toBeUndefined();
  });

  // ── The honesty boundary (ADR 0008, slice 3) ──────────────────────────────
  // The contract: an in-progress / in-review card is *never silently blank*
  // once a lookup is wired in. When the lookup has no verdict for the Issue —
  // its handle was never recorded (a previous session, an empty sidecar, or the
  // spawn/record gap) — the card reads **unknown**, never **live**. The only
  // path to **live** is a lookup that positively returns "live" for a handle
  // recorded *this* session. Silence on an in-progress card would re-introduce
  // the exact ambiguity the feature exists to kill, so the scanner defaults the
  // two active-agent lanes to unknown.

  it("defaults an in-progress Issue with no recorded handle to unknown, never live", () => {
    // A lookup that knows nothing about this Issue (the never-recorded case:
    // previous session, spawn/record gap). The card must read unknown — the
    // honest "this session can't see it" verdict — not stay blank.
    const { root } = liveRoot();
    const board = scanBoard(root, () => undefined);

    expect(issueById(featureIssues(board), "001-working.md").liveness).toBe(
      "unknown",
    );
  });

  it("defaults an in-review Issue with no recorded handle to unknown", () => {
    const { root } = liveRoot();
    const board = scanBoard(root, () => undefined);

    expect(issueById(featureIssues(board), "002-reviewing.md").liveness).toBe(
      "unknown",
    );
  });

  it("reads unknown for an in-progress Issue whose query was degraded", () => {
    // The lookup resolved this Issue to absent-degraded (its handle is gone, but
    // the query that said so couldn't be trusted). On the card this is
    // indistinguishable from the never-recorded case above — both honestly read
    // unknown, never orphaned.
    const { root, pathOf } = liveRoot();
    const board = scanBoard(root, (path) =>
      path === pathOf("001-working.md") ? "absent-degraded" : undefined,
    );

    expect(issueById(featureIssues(board), "001-working.md").liveness).toBe(
      "unknown",
    );
  });

  it("only ever reads live for an Issue the lookup positively resolves to live", () => {
    // The single path to a green "live" marker: a present-this-session handle
    // that the lookup matched against the live set. Its sibling in-progress
    // Issue, with no verdict, defaults to unknown — proving the two outcomes are
    // driven solely by the lookup's positive "live", never by silence.
    const { root, pathOf } = liveRoot();
    const board = scanBoard(root, (path) =>
      path === pathOf("001-working.md") ? "live" : undefined,
    );
    const issues = featureIssues(board);

    expect(issueById(issues, "001-working.md").liveness).toBe("live");
    expect(issueById(issues, "002-reviewing.md").liveness).toBe("unknown");
  });

  it("never defaults a non-liveness lane to unknown, even with a lookup present", () => {
    // The unknown default is scoped to the two active-agent lanes. A ready or
    // done card — which no agent owns — must stay blank, not pick up a spurious
    // unknown marker, even though the lookup is wired in.
    const { root } = liveRoot();
    const board = scanBoard(root, () => undefined);
    const issues = featureIssues(board);

    expect(issueById(issues, "003-queued.md").liveness).toBeUndefined();
    expect(issueById(issues, "004-shipped.md").liveness).toBeUndefined();
  });
});

describe("scanBoard review-pass overlay", () => {
  /**
   * A throwaway root with one in-review Issue (the only lane the count rides) plus
   * a done and a ready-for-review Issue the overlay must never touch. The review-pass
   * lookup is keyed by the Issue's absolute path — the same `prdDir/filename` key
   * the sidecar records (ADR 0008/0018) — exactly like the liveness lookup.
   */
  function reviewRoot(): { root: string; pathOf: (file: string) => string } {
    const root = mkdtempSync(join(tmpdir(), "overseer-revpass-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(join(dir, "prd.md"), "---\ntitle: Feature\n---\nbody\n");
    writeFileSync(join(dir, "001-reviewing.md"), "---\nstatus: in-review\n---\nbody\n");
    writeFileSync(join(dir, "002-awaiting.md"), "---\nstatus: ready-for-review\n---\nbody\n");
    writeFileSync(join(dir, "003-shipped.md"), "---\nstatus: done\n---\nbody\n");
    writeFileSync(
      join(dir, "004-escalated.md"),
      "---\nstatus: human-review\nhuman_review_reason: non-convergence\n---\nbody\n",
    );
    return { root, pathOf: (file) => join(dir, file) };
  }

  function featureIssues(board: ReturnType<typeof scanBoard>): readonly Issue[] {
    return prdById(board.prds, "feature").issues;
  }

  it("overlays the recorded pass on a live in-review Issue", () => {
    // The healthy path: a live in-review agent on pass 2 carries the count. The
    // liveness lookup resolves the Issue to live (its handle is in the registry),
    // and the review-pass lookup supplies the recorded pass.
    const { root, pathOf } = reviewRoot();
    const board = scanBoard(
      root,
      (path) => (path === pathOf("001-reviewing.md") ? "live" : undefined),
      undefined,
      undefined,
      (path) => (path === pathOf("001-reviewing.md") ? 2 : undefined),
    );

    expect(issueById(featureIssues(board), "001-reviewing.md").reviewPass).toBe(2);
  });

  it("reads the first pass as 1 (the moment review begins)", () => {
    const { root, pathOf } = reviewRoot();
    const board = scanBoard(
      root,
      () => "live",
      undefined,
      undefined,
      (path) => (path === pathOf("001-reviewing.md") ? 1 : undefined),
    );

    expect(issueById(featureIssues(board), "001-reviewing.md").reviewPass).toBe(1);
  });

  it("hides the count on an orphaned in-review Issue — the Orphan marker wins", () => {
    // A dead in-review agent is not "on pass N" of anything: even with a recorded
    // pass, an absent-clean (⇒ orphaned) verdict suppresses the count so the loud
    // Orphan marker stands alone (ADR 0018).
    const { root, pathOf } = reviewRoot();
    const board = scanBoard(
      root,
      (path) => (path === pathOf("001-reviewing.md") ? "absent-clean" : undefined),
      undefined,
      undefined,
      () => 2,
    );
    const issue = issueById(featureIssues(board), "001-reviewing.md");

    expect(issue.liveness).toBe("orphaned");
    expect(issue.reviewPass).toBeUndefined();
  });

  it("hides the count on an in-review Issue whose liveness is unknown", () => {
    // An agent the session can't see (no recorded handle / degraded query) reads
    // unknown — the count is gated to a positive live verdict, so it stays hidden.
    const { root } = reviewRoot();
    const board = scanBoard(root, () => undefined, undefined, undefined, () => 2);
    const issue = issueById(featureIssues(board), "001-reviewing.md");

    expect(issue.liveness).toBe("unknown");
    expect(issue.reviewPass).toBeUndefined();
  });

  it("never overlays the count off the in-review lane", () => {
    // The lookup claims a pass for every Issue and the liveness lookup says live —
    // but a ready-for-review or done card is not an in-review card, so neither
    // carries the count (it left the lane: still awaiting, or converged to done).
    const { root } = reviewRoot();
    const board = scanBoard(root, () => "live", undefined, undefined, () => 2);
    const issues = featureIssues(board);

    expect(issueById(issues, "002-awaiting.md").reviewPass).toBeUndefined();
    expect(issueById(issues, "003-shipped.md").reviewPass).toBeUndefined();
  });

  it("never overlays the count on a card escalated to human-review", () => {
    // A non-converged loop escalates to human-review: the count stops, the yellow
    // escalation marker takes over (the loop is no longer running). Even with the
    // lookup claiming a pass and a live verdict, an escalated card carries none.
    const { root } = reviewRoot();
    const board = scanBoard(root, () => "live", undefined, undefined, () => 3);

    expect(issueById(featureIssues(board), "004-escalated.md").reviewPass).toBeUndefined();
  });

  it("shows no count for a live in-review Issue with no recorded pass (no false 0/cap)", () => {
    // The lookup has no pass for the Issue (the spawn/record gap, a legacy entry):
    // absent ≠ 0, so the card carries no count rather than a false 0/cap.
    const { root } = reviewRoot();
    const board = scanBoard(root, () => "live", undefined, undefined, () => undefined);

    expect(issueById(featureIssues(board), "001-reviewing.md").reviewPass).toBeUndefined();
  });

  it("leaves the count unset when no review-pass lookup is provided", () => {
    // The default scan (board-only tests, the eager first render) carries no
    // overlay even on a live in-review card.
    const { root } = reviewRoot();
    const board = scanBoard(root, () => "live");

    expect(issueById(featureIssues(board), "001-reviewing.md").reviewPass).toBeUndefined();
  });
});

describe("scanBoard suppressed overlay", () => {
  /**
   * A throwaway root with one Issue in each lane that matters to the suppressed
   * overlay: the three suppressible lanes it applies to (ready-for-agent →
   * implementor edge, ready-for-review → reviewer edge, in-review → resolve edge —
   * ADR 0019), the `ready-for-human` card that shares the `ready` lane but is *not*
   * a spawn target, and the three lanes a lingering failed-set entry must stay
   * inert on (in-progress, done, backlog). The suppressed lookup is keyed by the
   * Issue's absolute path and the edge the lane implies.
   */
  function suppressedRoot(): { root: string; pathOf: (file: string) => string } {
    const root = mkdtempSync(join(tmpdir(), "overseer-suppressed-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(join(dir, "prd.md"), "---\ntitle: Feature\n---\nbody\n");
    writeFileSync(join(dir, "001-queued.md"), "---\nstatus: ready-for-agent\n---\nbody\n");
    writeFileSync(join(dir, "002-toreview.md"), "---\nstatus: ready-for-review\n---\nbody\n");
    writeFileSync(join(dir, "003-forhuman.md"), "---\nstatus: ready-for-human\n---\nbody\n");
    writeFileSync(join(dir, "004-working.md"), "---\nstatus: in-progress\n---\nbody\n");
    writeFileSync(join(dir, "005-reviewing.md"), "---\nstatus: in-review\n---\nbody\n");
    writeFileSync(join(dir, "006-shipped.md"), "---\nstatus: done\n---\nbody\n");
    writeFileSync(join(dir, "007-parked.md"), "---\nstatus: backlog\n---\nbody\n");
    return { root, pathOf: (file) => join(dir, file) };
  }

  function featureIssues(board: ReturnType<typeof scanBoard>): readonly Issue[] {
    return prdById(board.prds, "feature").issues;
  }

  it("stamps suppressed on a ready-for-agent card the lookup reports suppressed", () => {
    const { root, pathOf } = suppressedRoot();
    const board = scanBoard(
      root,
      undefined,
      (path, edge) => path === pathOf("001-queued.md") && edge === "implementor",
    );

    expect(issueById(featureIssues(board), "001-queued.md").suppressed).toBe(true);
  });

  it("stamps suppressed on a ready-for-review card the lookup reports suppressed", () => {
    const { root, pathOf } = suppressedRoot();
    const board = scanBoard(
      root,
      undefined,
      (path, edge) => path === pathOf("002-toreview.md") && edge === "reviewer",
    );

    expect(issueById(featureIssues(board), "002-toreview.md").suppressed).toBe(true);
  });

  it("derives the edge from the lane: ready-for-agent asks the implementor edge", () => {
    // The lookup says the implementor edge is suppressed but the reviewer edge is
    // not. A ready-for-agent card must be marked (it asks `implementor`); were the
    // scanner to ask the wrong edge it would read not-suppressed.
    const { root, pathOf } = suppressedRoot();
    const board = scanBoard(
      root,
      undefined,
      (path, edge) => path === pathOf("001-queued.md") && edge === "implementor",
    );

    expect(issueById(featureIssues(board), "001-queued.md").suppressed).toBe(true);
  });

  it("does not mark a card when only the other edge for its path is suppressed", () => {
    // The reviewer edge is suppressed for the ready-for-agent card's path, but the
    // card asks the implementor edge — one failing edge can't mask the other.
    const { root, pathOf } = suppressedRoot();
    const board = scanBoard(
      root,
      undefined,
      (path, edge) => path === pathOf("001-queued.md") && edge === "reviewer",
    );

    expect(issueById(featureIssues(board), "001-queued.md").suppressed).toBeUndefined();
  });

  it("stamps suppressed on an in-review card the lookup reports suppressed on resolve", () => {
    // A transient clean-merge failure (ADR 0019) holds the Issue at in-review and
    // records `(path, resolve)` in the failed-set; the marker must render on the
    // in-review lane, widened beyond the two `ready-*` spawn lanes.
    const { root, pathOf } = suppressedRoot();
    const board = scanBoard(
      root,
      undefined,
      (path, edge) => path === pathOf("005-reviewing.md") && edge === "resolve",
    );

    expect(issueById(featureIssues(board), "005-reviewing.md").suppressed).toBe(true);
  });

  it("derives the edge from the lane: in-review asks the resolve edge", () => {
    // The in-review card asks `resolve`, not a spawn edge: a lookup that suppresses
    // only the resolve edge for its path marks it, and one that suppresses only the
    // reviewer edge for that same path does not.
    const { root, pathOf } = suppressedRoot();
    const onResolve = scanBoard(
      root,
      undefined,
      (path, edge) => path === pathOf("005-reviewing.md") && edge === "resolve",
    );
    expect(issueById(featureIssues(onResolve), "005-reviewing.md").suppressed).toBe(true);

    const onReviewer = scanBoard(
      root,
      undefined,
      (path, edge) => path === pathOf("005-reviewing.md") && edge === "reviewer",
    );
    expect(
      issueById(featureIssues(onReviewer), "005-reviewing.md").suppressed,
    ).toBeUndefined();
  });

  it("does not mark an unrelated in-review card with no resolve suppression", () => {
    // Only the resolve-suppressed in-review Issue carries the marker; a sibling
    // in-review card the lookup reports clean stays unmarked, so a held merge is
    // visible without painting every in-review card.
    const { root, pathOf } = suppressedRoot();
    const dir = join(root, "feature");
    writeFileSync(join(dir, "008-other-review.md"), "---\nstatus: in-review\n---\nbody\n");
    const board = scanBoard(
      root,
      undefined,
      (path, edge) => path === pathOf("005-reviewing.md") && edge === "resolve",
    );

    expect(
      issueById(featureIssues(board), "008-other-review.md").suppressed,
    ).toBeUndefined();
  });

  it("never marks a ready-for-human card — it is not a spawn target", () => {
    // ready-for-human shares the `ready` lane with ready-for-agent but launches no
    // agent, so it has no suppressed edge. A lookup that claims every pair is
    // suppressed must leave it blank.
    const { root } = suppressedRoot();
    const board = scanBoard(root, undefined, () => true);

    expect(issueById(featureIssues(board), "003-forhuman.md").suppressed).toBeUndefined();
  });

  it("lane-gates: a lingering entry on a non-suppressible lane never marks the card", () => {
    // The lookup claims every (path, edge) is suppressed; only the three
    // suppressible lanes (ready-for-agent, ready-for-review, in-review) may carry
    // the marker. An in-progress / done / backlog card with a matching stale entry
    // stays blank — lane-gating is what makes the append-only set's stale entries
    // inert.
    const { root } = suppressedRoot();
    const board = scanBoard(root, undefined, () => true);
    const issues = featureIssues(board);

    expect(issueById(issues, "004-working.md").suppressed).toBeUndefined();
    expect(issueById(issues, "006-shipped.md").suppressed).toBeUndefined();
    expect(issueById(issues, "007-parked.md").suppressed).toBeUndefined();
  });

  it("leaves suppressed unset when no lookup is provided", () => {
    // The default scan (board-only tests, the eager first render) carries no
    // suppressed overlay — every card is blank even on the ready-* lanes.
    const { root } = suppressedRoot();
    const issues = featureIssues(scanBoard(root));

    expect(issueById(issues, "001-queued.md").suppressed).toBeUndefined();
    expect(issueById(issues, "002-toreview.md").suppressed).toBeUndefined();
  });

  it("leaves suppressed unset on a ready-* card the lookup reports not-suppressed", () => {
    // A lookup wired in but answering false stamps nothing — no `suppressed: false`
    // noise, only a positive true marks the card.
    const { root } = suppressedRoot();
    const board = scanBoard(root, undefined, () => false);

    expect(issueById(featureIssues(board), "001-queued.md").suppressed).toBeUndefined();
  });

  it("keeps the ready-* and in-progress lanes single-overlay; in-review is the deliberate overlap", () => {
    // Both overlays wired in and claiming everything. The `ready-*` lanes carry
    // only suppressed (no agent owns them) and `in-progress` only liveness (no
    // resolve edge); `in-review` is the one lane where the two overlap — a held
    // clean merge on a card whose reviewer also reads live/orphaned. The Card
    // resolves that overlap by precedence (suppressed wins).
    const { root } = suppressedRoot();
    const board = scanBoard(
      root,
      () => "live",
      () => true,
    );
    const issues = featureIssues(board);

    // in-progress: liveness only, never suppressed (no resolve edge on that lane).
    expect(issueById(issues, "004-working.md").liveness).toBe("live");
    expect(issueById(issues, "004-working.md").suppressed).toBeUndefined();
    // ready-for-agent: suppressed only, never liveness (no agent owns it).
    expect(issueById(issues, "001-queued.md").suppressed).toBe(true);
    expect(issueById(issues, "001-queued.md").liveness).toBeUndefined();
    // in-review: the deliberate overlap — both fields present on the model.
    expect(issueById(issues, "005-reviewing.md").suppressed).toBe(true);
    expect(issueById(issues, "005-reviewing.md").liveness).toBe("live");
  });

  it("never marks a card whose status collides with an Object.prototype name", () => {
    // A status of `toString` / `constructor` is a real string but not a recognised
    // authored status, so `placeStatus` folds it to `unsorted` — never a suppressed
    // lane. Because the edge is derived from the validated lane (not by indexing a
    // raw-status map), such a card can never reach the lookup at all: the lookup
    // here asserts it is only ever handed a real edge, and an unconditional `true`
    // return proves the card still stays unmarked.
    const root = mkdtempSync(join(tmpdir(), "overseer-suppressed-proto-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(join(dir, "prd.md"), "---\ntitle: Feature\n---\nbody\n");
    writeFileSync(join(dir, "001-proto.md"), "---\nstatus: toString\n---\nbody\n");

    const board = scanBoard(root, undefined, (_path, edge) => {
      expect(edge === "implementor" || edge === "reviewer").toBe(true);
      return true;
    });

    expect(issueById(featureIssues(board), "001-proto.md").suppressed).toBeUndefined();
  });
});

describe("scanBoard linked-PR overlay", () => {
  /**
   * Two throwaway PRDs: a `done` one (every Issue done) the overlay applies to,
   * and an in-progress one it must never touch — the overlay is gated to `done`
   * PRDs, the only ones with a feature-branch PR to surface (ADR 0013). The PR
   * lookup is keyed by the PRD's absolute directory path.
   */
  function prRoot(): { root: string; dirOf: (prd: string) => string } {
    const root = mkdtempSync(join(tmpdir(), "overseer-pr-"));
    const shipped = join(root, "shipped");
    mkdirSync(shipped);
    writeFileSync(join(shipped, "prd.md"), "---\ntitle: Shipped\n---\nbody\n");
    writeFileSync(join(shipped, "001-a.md"), "---\nstatus: done\n---\nbody\n");
    const wip = join(root, "wip");
    mkdirSync(wip);
    writeFileSync(join(wip, "prd.md"), "---\ntitle: WIP\n---\nbody\n");
    writeFileSync(join(wip, "001-a.md"), "---\nstatus: in-progress\n---\nbody\n");
    return { root, dirOf: (prd) => join(root, prd) };
  }

  it("overlays an open PR marker on a done PRD by its absolute dir path", () => {
    const { root, dirOf } = prRoot();
    const board = scanBoard(root, undefined, undefined, (prdDir) =>
      prdDir === dirOf("shipped")
        ? { state: "open", url: "https://gh/pr/1" }
        : undefined,
    );

    expect(prdById(board.prds, "shipped").linkedPr).toEqual({
      state: "open",
      url: "https://gh/pr/1",
    });
  });

  it("overlays a merged PR marker on a done PRD — the end-of-lifecycle signal", () => {
    const { root, dirOf } = prRoot();
    const board = scanBoard(root, undefined, undefined, (prdDir) =>
      prdDir === dirOf("shipped")
        ? { state: "merged", url: "https://gh/pr/2" }
        : undefined,
    );

    expect(prdById(board.prds, "shipped").linkedPr).toEqual({
      state: "merged",
      url: "https://gh/pr/2",
    });
  });

  it("leaves linkedPr unset on a done PRD the lookup reports no PR for", () => {
    // No PR ⇒ no marker (the three-state's third state is the overlay's absence).
    const { root } = prRoot();
    const board = scanBoard(root, undefined, undefined, () => undefined);

    expect(prdById(board.prds, "shipped").linkedPr).toBeUndefined();
  });

  it("never queries the lookup for a PRD that is not done", () => {
    // The overlay is gated to `done` PRDs only — the sole PRDs with a
    // feature-branch PR to surface, and the gate that bounds the per-scan `gh`
    // query to finished work (ADR 0013). The lookup claims every PRD has an open
    // PR; the in-progress one must stay blank and must never even be asked.
    const { root, dirOf } = prRoot();
    const queried: string[] = [];
    const board = scanBoard(root, undefined, undefined, (prdDir) => {
      queried.push(prdDir);
      return { state: "open", url: "https://gh/pr/9" };
    });

    expect(prdById(board.prds, "wip").linkedPr).toBeUndefined();
    expect(queried).toEqual([dirOf("shipped")]);
  });

  it("leaves linkedPr unset when no lookup is provided", () => {
    // The default scan (board-only tests, the eager first render) carries no
    // linked-PR overlay; a done PRD simply has no PR marker.
    const { root } = prRoot();
    const board = scanBoard(root);

    expect(prdById(board.prds, "shipped").linkedPr).toBeUndefined();
  });

  it("does not change the PRD's derived column when a PR is present (done stays done)", () => {
    // Surfacing a PR is a pure overlay — opening/merging it never alters the
    // derived status (ADR 0003): the done PRD stays in the done lane regardless of
    // its PR state.
    const { root } = prRoot();
    const board = scanBoard(root, undefined, undefined, () => ({
      state: "merged",
      url: "https://gh/pr/3",
    }));

    expect(prdById(board.prds, "shipped").lane).toBe("done");
  });
});

describe("scanBoard needs-review overlay", () => {
  /**
   * Build a throwaway PRD whose single Issue carries the given status, so the
   * needs-review roll-up can be exercised against an Issue parked (or not) in
   * `human-review`. The overlay is derived from the Issues at scan time — never
   * read from `prd.md` (ADR 0002 / 0003).
   */
  function prdWithIssueStatus(status: string): string {
    const root = mkdtempSync(join(tmpdir(), "overseer-nr-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(join(dir, "prd.md"), "---\ntitle: Feature\n---\nbody\n");
    writeFileSync(join(dir, "001-a.md"), `---\nstatus: ${status}\n---\nbody\n`);
    return root;
  }

  it("sets needsReview on a PRD with an Issue in human-review", () => {
    const board = scanBoard(prdWithIssueStatus("human-review"));

    expect(prdById(board.prds, "feature").needsReview).toBe(true);
  });

  it("leaves needsReview unset on a PRD with no Issue in human-review", () => {
    const board = scanBoard(prdWithIssueStatus("in-progress"));

    expect(prdById(board.prds, "feature").needsReview).toBeUndefined();
  });

  it("leaves needsReview unset on an empty PRD", () => {
    const root = mkdtempSync(join(tmpdir(), "overseer-nr-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(join(dir, "prd.md"), "---\ntitle: Feature\n---\nbody\n");

    const board = scanBoard(root);

    expect(prdById(board.prds, "feature").needsReview).toBeUndefined();
  });

  it("derives needsReview from the Issues regardless of any prd.md frontmatter", () => {
    // The overlay is a derived roll-up, never read from prd.md (ADR 0002 / 0003):
    // a prd.md asserting needs_review: false cannot suppress a genuine escalation,
    // and one asserting it true cannot fabricate a marker.
    const root = mkdtempSync(join(tmpdir(), "overseer-nr-"));
    const dir = join(root, "feature");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "prd.md"),
      "---\ntitle: Feature\nneeds_review: false\n---\nbody\n",
    );
    writeFileSync(join(dir, "001-a.md"), "---\nstatus: human-review\n---\nbody\n");

    const board = scanBoard(root);

    expect(prdById(board.prds, "feature").needsReview).toBe(true);
  });
});

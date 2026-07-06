#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import meow from "meow";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, ConfigError } from "./config.js";
import type { ReviewConfig } from "./review/reviewConfig.js";
import type { JiraConfig } from "./config.js";
import type { AgentConfig } from "./agentConfig.js";
import { realMirrorReconciler } from "./jira/mirrorReconciler.js";
import { scanBoard } from "./scanner.js";
import { watchRoot } from "./watcher.js";
import { LiveApp } from "./ui/LiveApp.js";
import { realUrlOpener } from "./ui/urlOpener.js";
import { createDetailReader } from "./ui/detailReader.js";
import { createAgentOutputReader, realLogs } from "./ui/agentOutputReader.js";
import { createDispatcher } from "./dispatch/dispatcher.js";
import { createReviewer } from "./review/reviewer.js";
import { createAuditor } from "./audit/auditor.js";
import { createRollback } from "./dispatch/rollback.js";
import { createKiller, realStop } from "./dispatch/kill.js";
import { createReactor } from "./reactor/reactor.js";
import { createFailedSet, suppressedSeam } from "./reactor/failedSet.js";
import { realGitSeam } from "./dispatch/gitSetup.js";
import { realMergeSeam } from "./review/mergeSeam.js";
import { createSpawnEdge, realExec, defaultLogPath } from "./dispatch/spawn.js";
import { appendSpawnAudit, defaultSpawnAuditPath } from "./dispatch/spawnAudit.js";
import { createAgentSidecar, defaultSidecarPath } from "./dispatch/agentSidecar.js";
import {
  createLivenessProbe,
  realLivenessQuery,
  type Absence,
} from "./dispatch/liveness.js";
import { realLinkedPrLookup } from "./dispatch/linkedPr.js";
import { createOpenPr, realOpenPrDeps } from "./dispatch/openPr.js";
import { createDelete, realDeleteDeps } from "./dispatch/deletePrd.js";
import { createMarkDone, realMarkDoneDeps } from "./dispatch/markDone.js";
import { createApprove, realApproveDeps } from "./review/approve.js";
import type { Board } from "./model.js";
import { runInit } from "./init/runInit.js";
import { runDoctor, formatReport, realProbe } from "./doctor/doctor.js";

const HELP = `
  Usage
    $ overseer            Render the live kanban board
    $ overseer init       Install bundled skills into the global Claude skills dir
    $ overseer doctor     Check prerequisites (Node, claude, git, gh, config)

  Options
    --help                Show this help
    --version             Show the installed version
`;

/** Print a user-facing error and exit non-zero — never returns. */
function fail(message: string): never {
  process.stderr.write(`overseer: ${message}\n`);
  process.exit(1);
}

/**
 * Load config → eager first `scanBoard` → render a {@link LiveApp} that re-scans
 * and re-renders on every debounced filesystem change, tearing the watcher down
 * when Ink unmounts.
 */
function runBoard(): void {
  let root: string;
  let review: ReviewConfig;
  let implementorAgent: AgentConfig;
  let reviewerAgent: AgentConfig;
  let auditorAgent: AgentConfig;
  let jira: JiraConfig;
  try {
    const config = loadConfig();
    root = config.root;
    review = config.review;
    implementorAgent = config.implementor;
    reviewerAgent = config.reviewer;
    auditorAgent = config.auditor;
    jira = config.jira;
  } catch (err) {
    if (err instanceof ConfigError) {
      fail(err.message);
    }
    throw err;
  }

  // The real spawn edge: confirming a dispatch validates each repo, ensures the
  // PRD feature branch, flips Issues to in-progress (driving the live board),
  // and launches a background `claude --bg` agent per spawn candidate.
  const { spawn: rawSpawn, logFailure } = createSpawnEdge({
    exec: realExec,
    logPath: defaultLogPath(),
  });
  // Wrap the one shared spawn seam every launch flows through — the Reactor's
  // auto-spawns and the manual `d`/`c`/`r` cranks all call this `spawn` — with a
  // best-effort spawn-audit line (timestamp, pid, edge, Issue, repo, outcome). It
  // is purely observational: it makes an over-spawn catchable (the same edge
  // relaunching the same Issue seconds apart shows as two lines) without changing
  // any spawn behaviour, and never throws, so the launch it wraps is unaffected.
  const spawnAuditPath = defaultSpawnAuditPath();
  const spawn = (repo: string, prompt: string, agent?: AgentConfig) => {
    try {
      const handle = rawSpawn(repo, prompt, agent);
      appendSpawnAudit(spawnAuditPath, { repo, prompt, handle });
      return handle;
    } catch (error) {
      // Record the failed launch too — a rolled-back spawn that retries is exactly
      // the double-spawn we want to see — then re-throw so rollback still happens.
      appendSpawnAudit(spawnAuditPath, { repo, prompt, handle: undefined, error });
      throw error;
    }
  };
  // The sidecar persists each spawned agent's captured `--bg` handle as
  // `issueKey → handle` outside the watched root (ADR 0008), so a later board
  // open can join a live `claude agents --json` row back to its Issue. Shared by
  // all three spawn paths (manual `d`/`r` and the Reactor) so every launched
  // agent is recorded identically; `read` feeds the liveness probe below.
  const { record: recordHandle, read: readEntries } =
    createAgentSidecar(defaultSidecarPath());
  // The liveness join and the kill switch only need `issueKey → handle`; the
  // sidecar's widened entry also carries the AI-review pass (ADR 0018), so project
  // the entries down to handles right at the join boundary. Keeping the projection
  // here leaves the liveness probe id-only and untouched by the schema widening —
  // a non-string handle can never match a live session `id`, so handle membership
  // is exactly what those two seams want.
  const readHandles = (): Record<string, string> => {
    const handles: Record<string, string> = {};
    for (const [issueKey, entry] of Object.entries(readEntries())) {
      handles[issueKey] = entry.handle;
    }
    return handles;
  };
  // The review-pass projection (ADR 0018): the loop control reads the count
  // Overseer recorded for an Issue off the same widened sidecar, so the Reactor
  // and the manual `r` keybind decide spawn-next-pass vs. escalate-at-cap from one
  // source of truth. Absent ⇒ no pass recorded ⇒ the first pass. Shared by both
  // review edges so a hand-driven loop steps the count identically to the auto
  // cascade; the same number is what a later card marker renders as `N/cap`.
  const readReviewPass = (issueKey: string): number | undefined =>
    readEntries()[issueKey]?.reviewPass;
  // The liveness probe (ADR 0008 / 0009): on each call it re-queries
  // `claude agents --json`, re-reads the recorded handles, and intersects them
  // into a per-Issue trust-qualified absence (live / absent-clean /
  // absent-degraded). The scanner maps that onto the card-level verdict behind
  // the active-lane gate. Wrapping `scanBoard` so the overlay is recomputed on
  // every rebuild keeps liveness a derived overlay, never persisted into the
  // Issue files (ADR 0002) — a handle that drops out flips to absent on the next
  // scan. `scanWithOverlays` (below) applies both the liveness and the suppressed
  // overlay, and is used for both the eager first render and the live re-scan, so
  // the board carries both overlays from the very first frame.
  const probe = createLivenessProbe({
    query: realLivenessQuery,
    readHandles,
  });
  // The one session-scoped failed-set, constructed per board run and shared
  // across all three spawn triggers below — the Reactor's auto-spawn and the
  // manual `d`/`r` edges. A launch failure on any edge records into this single
  // set, so a failed manual `d`/`r` is suppressed from the next reconcile exactly
  // as an automated failure is (ADR 0011). It is never persisted: reopening the
  // board builds a fresh set and retries every previously-failed spawn (ADR 0007).
  // Constructed before the scan callback so the read-only `suppressedSeam` over it
  // can drive the board's suppressed overlay (the spawn edges only ever write it).
  const failedSet = createFailedSet();
  const isSuppressed = suppressedSeam(failedSet);
  // The Linked PR overlay (ADR 0013): a live `gh pr list` per `done` PRD for its
  // derived feature branch, joined onto the PRD at overlay time and stored nowhere
  // — recomputed each scan exactly like Liveness, so a PR opened/merged/closed
  // outside Overseer is reflected on the next rebuild. `scanBoard` only calls it
  // for `done` PRDs (the only ones with a feature-branch PR), so the per-scan `gh`
  // query is bounded to finished work; a `gh` failure degrades to no marker.
  const lookupPr = realLinkedPrLookup();
  const scanWithOverlays = (r: string): Board => {
    // Run the probe *lazily*, memoised for this scan: `scanBoard` only calls the
    // liveness lookup for an in-progress / in-review card (LIVENESS_LANES), so a
    // board with no active-agent card never forks `claude agents --json` at all —
    // the subprocess is deferred to the first active card and reused for the rest.
    // The suppressed lookup is a pure in-memory `Set` read, so it needs no such
    // deferral. The two overlays gate disjoint lanes, so no card carries both.
    let verdicts: Record<string, Absence> | undefined;
    return scanBoard(
      r,
      (issuePath) => {
        verdicts ??= probe();
        return verdicts[issuePath];
      },
      isSuppressed,
      lookupPr,
      // The review-pass overlay (ADR 0018): the scanner joins the recorded pass
      // onto a *live* in-review card as the `N/cap` marker's numerator, reading the
      // very same `readReviewPass` projection the review loop's cap check reads —
      // one source of truth for control and display. A pure sidecar read, gated to
      // live-and-in-review by the scanner, so it never co-renders with the Orphan
      // marker and never persists into the Issue files (ADR 0002).
      readReviewPass,
    );
  };
  const initialBoard = scanWithOverlays(root);
  const dispatcher = createDispatcher(root, {
    git: realGitSeam,
    spawn,
    agent: implementorAgent,
    logFailure,
    recordHandle,
    failedSet,
  });
  // The reviewer reuses the very same `claude --bg` spawn edge — a reviewer is
  // just another background agent — flipping ready-for-review → in-review and
  // launching the reviewer in the Issue's repo.
  const reviewer = createReviewer(root, {
    spawn,
    agent: reviewerAgent,
    logFailure,
    recordHandle,
    readReviewPass,
    failedSet,
    review,
  });
  // The manual audit crank (`c`, PRD: Auditor Edge, ADR 0026): it reuses the very
  // same `claude --bg` spawn edge, failure log, and shared failed-set the Reactor's
  // audit pass uses, flipping ready-for-audit → in-audit and launching the auditor
  // in the Issue's repo — so a hand-driven `c` and an auto-spawned auditor behave
  // identically. It carries no review-pass count: the audit edge is a single pass.
  const auditor = createAuditor(root, {
    spawn,
    agent: auditorAgent,
    logFailure,
    recordHandle,
    failedSet,
  });
  // Orphan recovery (ADR 0009): `R` on an orphaned card rolls its active status
  // back onto its frontier through the same status seam the launch-failure
  // rollback uses. It spawns nothing — the normal spawn edge (the Reactor below
  // if auto-run is on, manual `d`/`r` if off) re-picks the Issue up — so unlike
  // the dispatcher/reviewer it needs no spawn or log seam.
  const rollback = createRollback(root);
  // The kill switch (ADR 0010): `K` on a `live` card `claude stop`s the agent
  // Overseer recorded for it, looked up in the same sidecar the liveness probe
  // reads. It writes no status — the stopped agent's Issue orphans and the
  // rollback above recovers it — so like the rollback it needs no spawn or log
  // seam, only the `claude stop` edge (realStop) and the sidecar read.
  const killer = createKiller(root, readHandles, realStop);
  // Open PR (CONTEXT.md, ADR 0013): `P` on a `done` PRD pushes its derived feature
  // branch and opens a GitHub PR from it into the repo's resolved default base —
  // the board's first outward GitHub writes, behind a confirm preview. It reuses
  // the same `gh`/`git` PrSeam the Linked PR overlay queries through (the write
  // methods sit beside the query) and `gitSetup`'s `defaultBase`, so the PR targets
  // the same base the feature branch was created from. A `gh`/`git` failure surfaces
  // loudly in the status line; the new PR shows via the overlay on the next scan.
  const openPr = createOpenPr(root, realOpenPrDeps());
  // Delete PRD (CONTEXT.md, ADR 0016): `X` on a `done` PRD removes its whole
  // directory — `prd.md`, every Issue file, and any other file — wholesale, behind
  // a confirm preview. The board's first destructive write to the watched root: a
  // single `fs.rmSync(dir, { recursive: true, force: true })` through the
  // DeleteSeam. The deleted Issues' liveness sidecar entries are left
  // dangling-but-inert. A removal failure surfaces loudly in the status line; the
  // existing `refresh` re-scan rebuilds the board without the deleted folder.
  const deleter = createDelete(root, realDeleteDeps());
  // Mark done (CONTEXT.md → mark done): `m` on a `ready-for-human` Issue advances
  // it straight to `done`, behind a confirm preview. The board's first
  // human-triggered status flip with no spawn behind it — it reuses the same
  // `writeStatus` primitive the dispatch/review rollback paths call, so the
  // watcher's re-scan moves the card to the `done` column. A cheap, trivially
  // reversible write (re-edit the field to undo), so it carries no result and
  // needs no rollback — the thinnest of the Issue-level seams.
  const markDone = createMarkDone(root, realMarkDoneDeps());
  // Approve (PRD: Approve from Board, ADR 0021): `A` on an approvable `human-review`
  // Issue runs the **same in-process merge the Reactor's clean-AI path does** —
  // merge the recorded worktree branch into the `featureBranchName`-derived PRD
  // feature branch, set `done`, clean up the worktree — behind a confirm preview. The
  // board's first human-triggered merge. It is the in-board twin of the
  // `/overseer-merge` skill, sharing the very `mergeWorktree`/`cleanUpWorktree` seam
  // the Reactor wraps (realApproveDeps binds the real merge seam), so the two
  // human/AI merge paths can never drift. It writes a terminal status but never
  // spawns — the two-spawn-edges invariant holds.
  const approve = createApprove(root, realApproveDeps());
  // The detail modal (ADR 0014): `v` reads the selected card's frontmatter-stripped
  // body off the watched root on demand — the PRD's `prd.md` at the board level, the
  // selected Issue's file when zoomed — and renders it through marked-terminal. A
  // pure read seam (no spawn, no write); the body is never carried in the Board model
  // (ADR 0003), so it always shows the file's current content. A vanished file makes
  // the keypress a harmless no-op.
  const detailReader = createDetailReader(root);
  // The agent-output modal (ADR 0023): `o` on a `live` card reads that agent's
  // recent terminal output once via `claude logs <handle>`, against the same
  // recorded handle the kill switch joins (the agent sidecar, via `readHandles`).
  // The read twin of `K` over one card's handle — a pure read seam (no spawn, no
  // write, no status change). The output is read on demand and frozen for the
  // modal's lifetime (close-and-reopen is the refresh), so it always reflects the
  // handle's current scrollback. A vanished Issue/handle makes the keypress a
  // harmless no-op; a `live` card with no recorded handle flashes a status-line
  // notice, exactly as Kill does in the same race.
  const agentOutputReader = createAgentOutputReader(root, readHandles, realLogs);
  // The Reactor reuses the very same validated git/spawn/log machinery, so its
  // automated dispatches behave identically to a manual `d`. The live loop
  // reconciles it after each board rebuild, closing the re-dispatch loop: a
  // completed Issue unblocks its siblings and they spawn with no second keypress.
  const reactor = createReactor(root, {
    git: realGitSeam,
    merge: realMergeSeam,
    spawn,
    logFailure,
    recordHandle,
    readReviewPass,
    failedSet,
    review,
    implementor: implementorAgent,
    reviewer: reviewerAgent,
    auditor: auditorAgent,
  });
  // The JIRA mirror (ADR 0028): the in-process sibling of the Linked-PR overlay,
  // reconciled fire-and-forget after each board rebuild. It pushes each opted-in
  // PRD's epic to JIRA off the render path — the board never blocks on it and its
  // acli failures degrade to logged no-ops (never a board marker or a crash). It
  // is always wired (the mirror is off *per PRD* via the authored `jira` block, not
  // by config), so an unconfigured board simply finds no opted-in PRDs and makes no
  // acli calls. The scheduling that keeps it off the render path lives in the live
  // loop; here we hand it the config's default board and status-name overrides.
  const mirrorReconciler = realMirrorReconciler({
    root,
    defaultBoard: jira.defaultBoard,
    statusNames: jira.statusNames,
  });
  const mirror = {
    reconcile: (b: Board): void => {
      // Fire-and-forget: every JiraSeam call is async (acli via execFile, never
      // execFileSync), so this call already returns before any subprocess I/O
      // happens — the board render never waits on acli. The reconciler swallows
      // its own per-PRD failures, so a rejected promise can't surface — but
      // guard anyway to honour "never throws out".
      void mirrorReconciler.reconcile(b).catch(() => {
        // Fire-and-forget: a mirror failure is never allowed to reach the board.
      });
    },
  };
  // Render on the terminal's alternate screen buffer (like vim/htop/less): the
  // board takes over the whole screen on launch and the user's prior shell
  // contents are restored untouched on quit. Ink manages enter/exit and restore.
  // Every fail-fast check above (loadConfig, the eager scanWithOverlays) runs
  // *before* this call, so a config/scan error still prints on the normal screen
  // rather than onto the alt buffer, where it would be wiped on restore. Both
  // subprocess overlays inside that eager scan are bounded (timeout + maxBuffer)
  // and degrade on any failure — the liveness query to unknown, the per-`done`
  // Linked PR query to no marker — so neither hangs startup nor throws here.
  render(
    <LiveApp
      root={root}
      initialBoard={initialBoard}
      scan={scanWithOverlays}
      watch={watchRoot}
      dispatcher={dispatcher}
      reviewer={reviewer}
      auditor={auditor}
      rollback={rollback}
      killer={killer}
      openPr={openPr}
      deleter={deleter}
      markDone={markDone}
      approve={approve}
      detailReader={detailReader}
      agentOutputReader={agentOutputReader}
      urlOpener={realUrlOpener}
      reactor={reactor}
      mirror={mirror}
      reviewCap={review.cap}
    />,
    { alternateScreen: true },
  );
}

/**
 * Thin wiring: parse argv, then branch on the subcommand *before* `loadConfig`,
 * so `init` works with no config present. With no subcommand, render the board.
 *
 * Any filesystem/environment failure from `init` (an unwritable skills dir, a
 * path occupied by a file, a missing shipped `skills/`) is surfaced as a clean
 * `overseer: …` message + non-zero exit — the same contract the board path uses
 * for {@link ConfigError} — rather than an uncaught stack trace.
 */
function main(): void {
  const cli = meow(HELP, { importMeta: import.meta });

  const subcommand = cli.input[0];
  if (subcommand === "init") {
    try {
      runInit({ entryUrl: import.meta.url });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (subcommand === "doctor") {
    // A one-shot preflight: print the checklist and exit non-zero iff a required
    // check failed, so `overseer doctor && overseer` (or a CI gate) can branch on
    // it. Runs *before* loadConfig — a missing/invalid config is itself one of the
    // checks, not a precondition for running them.
    const report = runDoctor({
      nodeVersion: process.version,
      probe: realProbe,
      loadConfig,
    });
    process.stdout.write(formatReport(report));
    process.exit(report.ok ? 0 : 1);
  }
  if (subcommand !== undefined) {
    fail(`unknown command '${subcommand}'. Run 'overseer --help' for usage.`);
  }
  runBoard();
}

/**
 * Run `main` only when this file is executed directly (the `overseer` bin), not
 * when it is imported — so importing the module has no argv-parsing, rendering,
 * or skill-installing side effects. Resolves symlinks (the npm `bin` shim) so
 * the comparison holds for a globally-installed package.
 */
function runningAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (runningAsScript()) {
  main();
}

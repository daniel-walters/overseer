import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { featureBranchName } from "./gitSetup.js";
import { readDispatchView } from "./reader.js";
import type { LinkedPr } from "../model.js";

/**
 * Linked PR: the read-path overlay that surfaces, on each `done` PRD, whether a
 * GitHub PR exists for its derived feature branch and that PR's state — derived
 * by a **live `gh` query**, stored nowhere (ADR 0013, CONTEXT.md). It mirrors
 * Liveness: a per-scan external query behind an injectable seam, joined onto the
 * board model at overlay time, never persisted into the PRD files (ADR 0002).
 *
 * The feature branch identity a query needs is *purely derived* from the PRD
 * directory name (reusing {@link featureBranchName}), so no stored link is ever
 * required — exactly the property ADR 0013 leans on. The {@link PrSeam} hides the
 * `gh` shell-out behind one narrow method (this slice introduces only its
 * *query*; the Open-PR write methods land in a later slice), so the whole
 * derivation is unit-tested with an in-memory fake and no real `gh`/network.
 *
 * It is gated to `done` PRDs only (the sole PRDs that can carry a feature-branch
 * PR) and bounded per scan, so the cost is proportional to finished work, and a
 * `gh` failure resolves to *no PR* — never a hang, an error state, or a crash.
 */

/**
 * The raw PR state a `gh` query reports for a branch — the GitHub vocabulary
 * (`gh pr list --json state` returns `OPEN` / `MERGED` / `CLOSED`). Only `OPEN`
 * and `MERGED` drive a marker; a closed-unmerged PR folds into *no PR* (the
 * marker disappears), so it is deliberately absent from this type — the query
 * seam reports it as no PR at all.
 */
export type PrState = "OPEN" | "MERGED";

/**
 * One PR as the query seam reports it: its {@link PrState} and the `url` the
 * `go to PR` keybind (a later slice) opens. `undefined` from the seam means *no
 * PR* — no open or merged PR exists for the branch (or the query failed, which
 * degrades to the same *no PR*, ADR 0013).
 */
export interface PrQueryResult {
  readonly state: PrState;
  readonly url: string;
}

/**
 * The injectable `gh`/`git` seam, mirroring the dispatch {@link import("./gitSetup.js").GitSeam}.
 * The read path uses only {@link PrSeam.query}; the Open-PR write path adds
 * {@link PrSeam.push} + {@link PrSeam.create} — the board's first outward GitHub
 * writes. A test fake answers from in-memory state and records the writes; the
 * {@link realPrSeam} shells out to `git`/`gh`.
 *
 * The query is *total* (a `gh` failure resolves to *no PR*, never throws, ADR
 * 0013) because it runs on the scan's hot path. The two writes, by contrast,
 * **throw** on failure: they fire only behind the confirmed, human-gated Open PR
 * action, where a failure must surface loudly in the status line (like a spawn
 * failure) rather than be silently swallowed — so the orchestration catches the
 * throw and reports it.
 */
export interface PrSeam {
  /**
   * Query GitHub for a PR on `branch` in `repo`, returning its state + url, or
   * `undefined` when none exists. Total: a `gh` failure (missing, unauthed,
   * non-GitHub remote, network) resolves to `undefined` — *no PR* — never throws
   * out of the scan path (ADR 0013).
   */
  query(repo: string, branch: string): PrQueryResult | undefined;
  /**
   * Push `branch` to `origin` in `repo`. The normal case is a feature branch that
   * only ever lived locally (review merges into it locally, nothing pushes it), so
   * Open PR pushes before it creates. Throws on failure (no remote, no auth,
   * network) so the orchestration can surface it loudly.
   */
  push(repo: string, branch: string): void;
  /**
   * Open a GitHub PR from `branch` into `base` in `repo`, returning the new PR's
   * url. The board's first `gh pr create`. Throws on failure (no `gh`, unauthed,
   * non-GitHub remote, network) so the orchestration can surface it loudly.
   */
  create(repo: string, branch: string, base: string): string;
}

/**
 * Derive the Linked PR overlay for one `done` PRD's `repo` + feature `branch` by
 * querying the seam and mapping the raw {@link PrState} onto the card-level
 * {@link LinkedPr}. `undefined` (no PR, or a degraded query) yields no overlay —
 * the marker simply disappears. Pure given the seam, so it is exhaustively
 * testable with a fake query response.
 */
export function deriveLinkedPr(
  seam: PrSeam,
  repo: string,
  branch: string,
): LinkedPr | undefined {
  const result = seam.query(repo, branch);
  if (result === undefined) return undefined;
  return { state: result.state === "OPEN" ? "open" : "merged", url: result.url };
}

/** A `prdDir → LinkedPr | undefined` overlay lookup the scanner joins per scan. */
export type LinkedPrLookup = (prdDir: string) => LinkedPr | undefined;

/** The seams a {@link createLinkedPrLookup} depends on, injected for testing. */
export interface LinkedPrLookupDeps {
  /** Query a PR for a repo + branch (the default seam shells out to `gh`). */
  readonly seam: PrSeam;
  /**
   * The distinct `repo:` values across a PRD's Issues, in first-seen order — the
   * single-repo guard's input. The default reads each Issue's frontmatter; a test
   * fake answers from in-memory state. A v1 PR can only target one repo, so the
   * lookup queries only when this yields exactly one.
   */
  readonly readRepos: (prdDir: string) => readonly string[];
}

/**
 * Build the Linked PR overlay lookup: a `(prdDir) => LinkedPr | undefined` that,
 * for one `done` PRD, derives its feature branch from the directory name (reusing
 * {@link featureBranchName} — the same name the Open-PR write path would push),
 * resolves the PRD's single repo, queries the seam, and maps the result to the
 * three-state overlay. The scanner gates this to `done` PRDs and recomputes it on
 * each scan, so the marker is a derived overlay, never persisted (ADR 0002 /
 * 0013) — a PR opened, merged, or closed outside Overseer is reflected on the
 * next scan.
 *
 * Total by construction: a multi-repo or repo-less PRD (no single feature-branch
 * PR to surface in v1) yields no overlay without shelling out, and any failure —
 * a thrown repo read (the watched root deleting the PRD mid-scan) or a thrown
 * `gh` query (missing, unauthed, non-GitHub remote, network) — degrades to *no
 * PR* (no marker), never an error state, hang, or crash (ADR 0013).
 */
export function createLinkedPrLookup(deps: LinkedPrLookupDeps): LinkedPrLookup {
  return (prdDir: string): LinkedPr | undefined => {
    try {
      const repos = deps.readRepos(prdDir);
      // A v1 PR targets exactly one repo: a multi-repo PRD has a per-repo feature
      // branch (no single PR to surface — the write path refuses it), and a
      // repo-less PRD has nothing to query. Either way, no overlay, no shell-out.
      const [repo, ...rest] = repos;
      if (repo === undefined || rest.length > 0) return undefined;
      const branch = featureBranchName(basename(prdDir));
      return deriveLinkedPr(deps.seam, repo, branch);
    } catch {
      // A repo read that threw (the PRD vanished mid-scan) or a query that threw
      // (a `gh` failure the seam didn't itself absorb) degrades to no marker —
      // never out of the scan, never an error state on the card (ADR 0013).
      return undefined;
    }
  };
}

/**
 * The production `readRepos`: the distinct, non-empty `repo:` values across a
 * PRD's Issues, in first-seen order. Reads each Issue's frontmatter via the
 * dispatch reader — the same `repo:` field dispatch validates — so the overlay's
 * single-repo guard sees exactly the repos dispatch would. The lookup wraps this
 * in a try/catch, so a PRD that vanished mid-scan (the read throwing) degrades to
 * no marker rather than out of the scan.
 */
export function realReadRepos(prdDir: string): readonly string[] {
  const seen = new Set<string>();
  for (const issue of readDispatchView(prdDir).issues) {
    const repo = issue.repo?.trim();
    if (repo) seen.add(repo);
  }
  return [...seen];
}

/**
 * Build the production Linked PR overlay lookup wired to the real `gh` seam and
 * the real per-PRD repo read — the one the CLI passes to `scanBoard`. A thin
 * convenience over {@link createLinkedPrLookup} so the wiring site need not name
 * both default seams.
 */
export function realLinkedPrLookup(): LinkedPrLookup {
  return createLinkedPrLookup({ seam: realPrSeam, readRepos: realReadRepos });
}

/**
 * How long to wait for `gh pr list` before giving up. Like the Liveness query,
 * this runs synchronously on the scan path (one call per `done` PRD), so an
 * unbounded query would freeze the Ink render loop if `gh` hung or was slow. On
 * timeout `execFileSync` throws, which the seam catches and reports as *no PR* —
 * the cap fails safe: a slow query costs at most this delay, never a frozen board.
 */
const QUERY_TIMEOUT_MS = 3000;

/**
 * Cap on captured stdout. A branch's PR list is tiny (at most a handful of rows),
 * so the default would never be hit; the explicit cap just guarantees a runaway
 * `gh` can't be read into an unbounded buffer on the render path. Overflow throws,
 * which the seam reports as *no PR*.
 */
const QUERY_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Parse `gh pr list --json state,url` stdout into the PR this overlay surfaces, or
 * `undefined` for *no PR*. The output is a JSON array of `{ state, url }` rows for
 * the head branch. We fold it to a single result: an **OPEN** PR wins (it is the
 * live one awaiting merge), else a **MERGED** PR (the end-of-lifecycle signal),
 * else nothing — a **CLOSED**-unmerged PR folds into *no PR* (the marker
 * disappears, per CONTEXT.md / ADR 0013). Total over bad input: unparseable or
 * non-array output yields *no PR*, so the board never crashes on a `gh` hiccup.
 */
export function parsePrList(json: string): PrQueryResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  let merged: PrQueryResult | undefined;
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const { state, url } = record;
    if (typeof state !== "string" || typeof url !== "string") continue;
    // An OPEN PR is the live one — return it immediately, ahead of any merged row.
    if (state === "OPEN") return { state: "OPEN", url };
    // Hold the first MERGED as the fallback; keep scanning in case an OPEN follows.
    if (state === "MERGED" && merged === undefined) merged = { state: "MERGED", url };
  }
  return merged;
}

/**
 * The production `gh` query seam: shell out to `gh pr list` for `branch` in `repo`
 * and parse the first relevant PR. `--state all` so a *merged* PR is visible (the
 * default lists only open ones), `--json state,url` for the two fields the overlay
 * reads. Bounded by {@link QUERY_TIMEOUT_MS} / {@link QUERY_MAX_BUFFER} because it
 * runs on the scan's hot path; any failure — `gh` missing, unauthed, a non-GitHub
 * remote, network, timeout, or overflow — is caught and reported as *no PR* (no
 * marker), never a throw out of the scan (ADR 0013). This is the un-fakeable
 * shell-out boundary, kept thin and excluded from unit tests exactly as the real
 * `GitSeam` / Liveness shell-outs are; {@link parsePrList} carries the testable logic.
 */
export const realPrSeam: PrSeam = {
  query(repo: string, branch: string): PrQueryResult | undefined {
    try {
      const out = execFileSync(
        "gh",
        ["pr", "list", "--head", branch, "--state", "all", "--json", "state,url"],
        {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
          timeout: QUERY_TIMEOUT_MS,
          maxBuffer: QUERY_MAX_BUFFER,
        },
      );
      return parsePrList(out);
    } catch {
      // gh missing / unauthed / non-GitHub remote / network / timeout / overflow:
      // a `done` PRD simply shows no PR, the board degrades honestly (ADR 0013).
      return undefined;
    }
  },

  // The two Open-PR writes — the board's first outward GitHub actions. Unlike the
  // query they are *not* bounded by the scan timeout and they let failures throw:
  // they run only behind the confirmed `open PR` keybind, where the orchestration
  // catches the throw and surfaces it loudly in the status line (like a spawn
  // failure), and a push/create can legitimately take longer than a list. They are
  // the un-fakeable shell-out boundary, kept thin and excluded from unit tests
  // exactly as `realGitSeam`'s git calls and the query above are.
  push(repo: string, branch: string): void {
    execFileSync("git", ["-C", repo, "push", "--set-upstream", "origin", branch], {
      stdio: ["ignore", "pipe", "inherit"],
    });
  },

  create(repo: string, branch: string, base: string): string {
    const out = execFileSync(
      "gh",
      ["pr", "create", "--head", branch, "--base", base, "--fill"],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    // `gh pr create` prints the new PR's url as its last non-empty output line.
    return out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  },
};

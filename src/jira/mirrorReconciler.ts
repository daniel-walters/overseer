import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { errorMessage } from "../errorMessage.js";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import {
  parseJiraOptIn,
  readPresentString,
  readString,
  safeMatter,
  writeJiraStory,
  writeJiraKey,
  DEFAULT_JIRA_TARGET,
  FIELD,
  type JiraOptIn,
} from "../issueFile.js";
import {
  DEFAULT_ISSUE_STATUS_NAMES,
  storyTargetStatus,
  issueTargetStatus,
  statusEquals,
  type IssueStatusNames,
} from "./statusMapping.js";
import { realJiraSeam, type JiraSeam } from "./jiraSeam.js";
import {
  createPacedWriteQueue,
  type PacedWriteQueue,
} from "./pacedWriteQueue.js";
import type { Board, Issue } from "../model.js";

/**
 * Production pacing for the write queue (ADR 0028, user story 20): at most this
 * many writes are kicked off per {@link MIRROR_WRITE_INTERVAL_MS} tick, so the one
 * real burst — a bulk first sync or a wide dispatch wave — drains over a few
 * seconds instead of firing all at once and tripping JIRA's rate limit. Steady
 * state is a trickle the diff-gate already keeps tiny, so these need only tame the
 * outlier, not throttle normal operation.
 */
export const MIRROR_WRITE_BURST = 5;
/** Milliseconds the paced write queue waits between drain ticks. */
export const MIRROR_WRITE_INTERVAL_MS = 1000;

/**
 * The reconciler spine of the JIRA mirror (ADR 0028, ADR 0032) — the in-process
 * sibling of the Linked-PR overlay (ADR 0013), driven on the existing scan loop.
 * For each opted-in PRD on the board it ensures the PRD's **Story** (the feature
 * card) exists in JIRA (create once, write the {@link FIELD.jiraStory} backref)
 * and self-heals the Story's status toward the PRD's derived lane. The board is the
 * sole source of truth; on any status mismatch the board wins and the mirror drives
 * the Story back (ADR 0028).
 *
 * **Fire-and-forget.** The board never blocks on it and it never throws out: every
 * PRD's reconcile is wrapped so a {@link JiraSeam}/acli failure — a missing board,
 * an illegal transition, a network error — is a *logged no-op* (ADR 0028), never a
 * crash and never a board marker. It returns a {@link MirrorDelta} of the actions
 * it took purely so the behaviour is assertable through the seam boundary.
 *
 * **Diff-gated (ADR 0028).** On board-open the first {@link MirrorReconciler.reconcile}
 * seeds an in-memory last-known-bucket cache from **one** JQL fetch
 * ({@link JiraSeam.searchStatuses}) of every mirrored key. Thereafter each scan
 * computes each Story/Sub-task's target bucket and diffs it against the cache purely
 * in memory — no network read — emitting only the deltas (transitions) and
 * advancing the cache on each success. Scan frequency is thereby decoupled from
 * write frequency: a busy dispatch wave that scans many times yields only the
 * handful of writes where a bucket actually crossed, and a scan that crosses no
 * bucket makes zero JIRA calls at all. A human-dragged JIRA card is corrected on
 * the next board-open, when the reseed captures its drifted status and the diff
 * against the board's target drives it back (board wins).
 *
 * **Idempotent across restarts.** Identity is the frontmatter backref (ADR 0029):
 * a PRD that already carries `jira_story` is update-or-noop, never a second Story —
 * so losing all in-memory state (a restart, a fresh machine) can never duplicate
 * a Story. Writing the backref fires a watcher re-scan → another reconcile, which
 * the present backref + the cache (advanced to target on the create) collapse to a
 * zero-JIRA no-op.
 *
 * **Re-entrancy guard.** The backref that makes create idempotent is only written
 * *after* `createStory` resolves, and each acli round-trip can run for seconds —
 * far longer than the watcher's {@link import("../watcher.js").DEBOUNCE_MS}. An
 * unrelated file change can fire a second `reconcile()` while a first pass is
 * still awaiting a PRD's create, and that second pass would read the same
 * not-yet-backreffed `prd.md` and create a second Story. `reconcile()` follows the
 * same guard {@link import("../reactor/reactor.js").createReactor} uses: a call
 * that arrives while one is already in flight is a clean no-op, same as it would
 * be if the file watcher simply hadn't coalesced the two events.
 *
 * **Paced writes (ADR 0028, user story 20).** Every write a pass makes — Story and
 * Sub-task creates, status transitions, sprint assignments — is routed through a
 * {@link PacedWriteQueue}, so a single reconcile's bulk fan-out (the first sync of
 * an already-populated PRD, or a wide dispatch wave) drains a bounded burst per
 * tick over a few seconds rather than firing all at once and tripping JIRA's rate
 * limit. Steady state stays a trickle (the diff-gate keeps it tiny), so the queue
 * only ever tames the outlier. A PRD's Sub-tasks are reconciled concurrently so
 * their writes reach the queue as one batch; Story-before-Sub-task ordering survives
 * because the Story's create is awaited before any Sub-task's create is submitted.
 * Still fire-and-forget: the board never awaits the queue, and a half-drained
 * queue just means JIRA is a few seconds behind (already acceptable — it is stale
 * whenever the TUI is closed).
 */
export interface MirrorReconciler {
  /**
   * Reconcile every opted-in PRD on the board toward JIRA; resolves to what it
   * did. Async because every {@link JiraSeam} call is a real subprocess
   * round-trip — awaiting between PRDs keeps the render loop and keyboard input
   * live for the whole pass (ADR 0028: "the board never blocks on it").
   */
  reconcile(board: Board): Promise<MirrorDelta>;
}

/** What one reconcile pass changed in JIRA — the assertable delta set. */
export interface MirrorDelta {
  /** Stories created this pass (in board order). */
  readonly created: readonly CreatedStory[];
  /** Story status transitions executed this pass (in board order). */
  readonly transitioned: readonly StoryTransition[];
  /** Sub-tasks created this pass (in board/Issue order). */
  readonly childrenCreated: readonly CreatedChild[];
  /** Sub-task status transitions executed this pass (in board/Issue order). */
  readonly childrenTransitioned: readonly ChildTransition[];
  /**
   * Stories placed into a sprint this pass (in board order). Only a
   * `target: sprint` PRD's *freshly-created* Story appears here — placement is set
   * once at create and never re-evaluated, and `target: backlog` Stories are never
   * placed (they need no action to stay in the backlog). Under the feature-card
   * shape only the Story is ever placed; its Sub-tasks follow it by JIRA's own
   * rules (ADR 0032), so a Sub-task is never placed independently.
   */
  readonly placed: readonly StoryPlacement[];
}

/** One Story created this pass: the PRD it mirrors and the new JIRA key. */
export interface CreatedStory {
  readonly prd: string;
  readonly key: string;
}

/** One Story status self-heal: the Story key and the target status it moved to. */
export interface StoryTransition {
  readonly key: string;
  readonly to: string;
}

/** One Sub-task created this pass: the Issue (filename) it mirrors and the new JIRA key. */
export interface CreatedChild {
  readonly issue: string;
  readonly key: string;
}

/** One Sub-task status self-heal: the Sub-task key and the target status it moved to. */
export interface ChildTransition {
  readonly key: string;
  readonly to: string;
}

/** One Story sprint placement: the PRD it mirrors, its Story key, and the sprint id it landed in. */
export interface StoryPlacement {
  readonly prd: string;
  readonly key: string;
  readonly sprint: string;
}

/** The empty delta — a pass (or an overlapping call) that changed nothing in JIRA. */
function emptyDelta(): MirrorDelta {
  return {
    created: [],
    transitioned: [],
    childrenCreated: [],
    childrenTransitioned: [],
    placed: [],
  };
}

/**
 * The mirror-relevant state read off a PRD's `prd.md`: its opt-in block (absent ⇒
 * the PRD is invisible to the mirror) and its Story backref (absent ⇒ no Story yet).
 */
export interface MirrorFileState {
  readonly optIn?: JiraOptIn;
  readonly storyKey?: string;
}

/**
 * The mirror-relevant state read off one Issue file: its authored `status` (the
 * raw string the Sub-task's target bucket maps from — read from the file, not the
 * board's already-collapsed lane, so audit statuses map correctly), its body
 * **prose with frontmatter stripped** (the Sub-task description), and its Sub-task
 * backref (absent ⇒ no Sub-task yet). A missing/unreadable Issue reads as
 * all-absent.
 */
export interface IssueMirrorState {
  readonly status?: string;
  readonly body?: string;
  readonly childKey?: string;
}

/** The injectable collaborators, defaulted to the real acli/file wiring in {@link realMirrorDeps}. */
export interface MirrorReconcilerDeps {
  /** The scanned root; a PRD's directory is `join(root, prd.id)`. */
  readonly root: string;
  /** The JIRA I/O port (acli in production, a fake in tests). */
  readonly seam: JiraSeam;
  /**
   * The paced write queue every mirror *write* (Story/Sub-task create, transition,
   * sprint assignment) is routed through, so a single reconcile's bulk fan-out
   * drains a bounded burst per tick rather than firing all at once (ADR 0028, user
   * story 20). Defaults to a {@link createPacedWriteQueue} tuned to
   * {@link MIRROR_WRITE_BURST}/{@link MIRROR_WRITE_INTERVAL_MS}; tests inject a
   * clocked queue to assert the pacing, or an immediate one to assert ordering
   * without the timing dimension.
   */
  readonly queue?: PacedWriteQueue;
  /**
   * Status-name targets for both halves; defaults to the conventional
   * {@link DEFAULT_ISSUE_STATUS_NAMES}. The four-bucket Issue superset feeds the
   * Sub-task self-heal *and* — being structurally a {@link StoryStatusNames} — the
   * three-bucket Story self-heal, so one override map serves both.
   */
  readonly statusNames?: IssueStatusNames;
  /** The config's `default_board`, used when a PRD's opt-in names no board. */
  readonly defaultBoard?: string;
  /** Read a PRD's opt-in + Story backref from its `prd.md`. */
  readonly readMirror: (prdDir: string) => MirrorFileState;
  /** Write the Story backref onto a PRD's `prd.md`. */
  readonly writeStory: (prdDir: string, key: string) => void;
  /** Read an Issue file's status + body prose + Sub-task backref (keyed by its absolute path). */
  readonly readIssueMirror: (issuePath: string) => IssueMirrorState;
  /** Write the Sub-task backref onto an Issue file. */
  readonly writeIssueKey: (issuePath: string, key: string) => void;
  /** Where a no-op/failure is logged (the mirror never surfaces to the board). */
  readonly log?: (message: string) => void;
}

/**
 * Build a {@link MirrorReconciler} over the given collaborators. Pure orchestration
 * given the seam and file readers/writers — no acli, no filesystem — so it is
 * unit-tested against a fake seam (asserting the delta set and calls made).
 */
export function createMirrorReconciler(
  deps: MirrorReconcilerDeps,
): MirrorReconciler {
  const statusNames = deps.statusNames ?? DEFAULT_ISSUE_STATUS_NAMES;
  const log = deps.log ?? (() => {});
  const queue =
    deps.queue ??
    createPacedWriteQueue({
      burst: MIRROR_WRITE_BURST,
      intervalMs: MIRROR_WRITE_INTERVAL_MS,
    });
  /** True while a reconcile is in flight; the re-entrancy guard reads it. */
  let reconciling = false;
  /**
   * The last-known-bucket cache (ADR 0028): JIRA key → the named status the mirror
   * last knew that issue to be in. Seeded once from a single JQL fetch on board-open
   * (the first {@link reconcile}), then maintained purely in memory — updated on
   * every successful transition and every create. Each scan diffs the board's
   * target against this cache with no network read, so a scan that crosses no
   * bucket makes zero JIRA calls.
   */
  const cache = new Map<string, string>();
  /** False until the open-time JQL seed has run (once, on the first reconcile). */
  let seeded = false;

  return {
    async reconcile(board: Board): Promise<MirrorDelta> {
      // A pass already in flight owns this tick's writes; a second call arriving
      // before it settles (see the class doc's re-entrancy note) is a no-op rather
      // than racing it onto the same not-yet-backreffed PRDs.
      if (reconciling) return emptyDelta();
      reconciling = true;
      try {
        // Board-open seed (ADR 0028): one JQL fetch of every already-mirrored key,
        // inside the guard so it runs exactly once and never races a second pass.
        // A fresh board with no backrefs collects no keys → no acli call at all.
        // Only latch `seeded` on a *successful* seed (including the trivial
        // zero-keys case): a transient acli/network failure must retry on the
        // next reconcile rather than permanently stranding the cache empty for
        // the rest of the process's life — an empty cache makes every linked
        // key's diff-gate a permanent cache-miss, so `driveToTarget` would
        // otherwise re-attempt a live transition on every single future scan
        // forever, exactly the JIRA-call volume the seed exists to eliminate.
        if (!seeded) {
          seeded = await seedCache(board, deps, cache, log);
        }
        return await reconcileOnce(board, deps, queue, statusNames, cache, log);
      } finally {
        reconciling = false;
      }
    },
  };
}

/**
 * Seed the last-known-bucket cache from **one** JQL search over every mirrored key
 * on the board (ADR 0028): the Story backref of each opted-in PRD plus each of its
 * Issues' Sub-task backrefs. A PRD with no `jira` block contributes nothing (it is
 * invisible to the mirror), and a board with no backrefs yet collects no keys — so
 * {@link JiraSeam.searchStatuses} short-circuits without shelling out. The seed is
 * the mirror's *only* JIRA read; every later scan diffs against this cache in
 * memory.
 *
 * Returns whether the seed may be considered done: `true` when there was nothing
 * to seed, or the search succeeded (whether or not every key came back with a
 * readable status); `false` on a search failure, so the caller does **not** latch
 * `seeded` — a transient acli/network error retries on the very next reconcile
 * instead of permanently stranding the cache empty (which would otherwise turn
 * every linked key into a forever cache-miss, and `driveToTarget` would re-attempt
 * a live transition on every future scan for the rest of the process's life,
 * defeating the diff-gate's whole point). Each retry is logged as a no-op in the
 * meantime, so the failure is still visible without taking down the board.
 */
async function seedCache(
  board: Board,
  deps: MirrorReconcilerDeps,
  cache: Map<string, string>,
  log: (message: string) => void,
): Promise<boolean> {
  const keys: string[] = [];
  for (const prd of board.prds) {
    const prdDir = join(deps.root, prd.id);
    const { optIn, storyKey } = deps.readMirror(prdDir);
    if (optIn === undefined) continue;
    if (storyKey !== undefined) keys.push(storyKey);
    for (const issue of prd.issues) {
      const { childKey } = deps.readIssueMirror(join(prdDir, issue.id));
      if (childKey !== undefined) keys.push(childKey);
    }
  }
  if (keys.length === 0) return true;
  try {
    for (const { key, status } of await deps.seam.searchStatuses(keys)) {
      // Only a readable status seeds the cache; a found-but-unreadable one stays
      // absent, so the diff treats it as unknown and heals toward the board's truth.
      if (status !== undefined) cache.set(key, status);
    }
    return true;
  } catch (err) {
    log(
      `mirror cache seed failed — reconciling with an empty cache (no-op), will retry on the next scan: ${errorMessage(err)}`,
    );
    return false;
  }
}

async function reconcileOnce(
  board: Board,
  deps: MirrorReconcilerDeps,
  queue: PacedWriteQueue,
  statusNames: IssueStatusNames,
  cache: Map<string, string>,
  log: (message: string) => void,
): Promise<MirrorDelta> {
  const created: CreatedStory[] = [];
  const transitioned: StoryTransition[] = [];
  const childrenCreated: CreatedChild[] = [];
  const childrenTransitioned: ChildTransition[] = [];
  const placed: StoryPlacement[] = [];

  // Shared across every PRD in this pass (not one per PRD): two or more
  // `target: sprint` PRDs mirroring to the same board (their own `board` or a
  // common `default_board`) must not each pay for their own
  // `resolveActiveSprint` acli call — see {@link createSprintResolver}.
  const resolveSprintForBoard = createSprintResolver(deps, log);

  for (const prd of board.prds) {
    const prdDir = join(deps.root, prd.id);
    try {
      const { optIn, storyKey } = deps.readMirror(prdDir);
      // No `jira` block ⇒ the PRD is invisible to the mirror (ADR 0028).
      if (optIn === undefined) continue;

      // The board this PRD mirrors to (its own `board`, else the config default):
      // needed both to resolve the project when creating the Story and to resolve
      // the active sprint when placing it. Computed once here so a linked PRD
      // (Story already exists) still has a board to resolve sprints against.
      const boardId = optIn.board ?? deps.defaultBoard;
      // Where this PRD's Story lands at create (sprint vs backlog); an absent
      // `target` defaults to backlog (the least-invasive placement — ADR 0028).
      // Its Sub-tasks follow the Story by JIRA's own rules (ADR 0032).
      const placement = optIn.target ?? DEFAULT_JIRA_TARGET;

      // Ensure the Story exists: a present backref is update-or-noop (never a
      // second Story — ADR 0029); an absent one creates then writes the backref.
      let key = storyKey;
      if (key === undefined) {
        if (boardId === undefined) {
          log(
            `PRD ${prd.id}: jira opt-in names no board and no default_board is configured — skipping (no-op).`,
          );
          continue;
        }
        const project =
          optIn.project ?? (await deps.seam.resolveProject(boardId));
        // The create is a write, so it drains through the paced queue like every
        // other — but it is *awaited* here before any of this PRD's Sub-tasks are
        // submitted, which is exactly how Story-before-Sub-task ordering survives
        // the queue: a Sub-task create can only enter the queue once its parent's
        // key (and backref) exist.
        key = await queue.run(() =>
          deps.seam.createStory({ project, summary: prd.title }),
        );

        // The Story now exists in JIRA; write the backref so the next pass
        // treats it as update-or-noop instead of creating a second Story
        // (ADR 0029). If the write itself fails (disk full, permission,
        // lock), the Story is orphaned — present in JIRA with no backref —
        // and every future pass will re-create it, since there is no other
        // durable state the mirror is allowed to keep (ADR 0028: no
        // backend). Log that specific, higher-stakes failure distinctly
        // (not folded into the generic per-PRD no-op below) so an operator
        // can see the duplicate-Story risk and add the backref by hand.
        try {
          deps.writeStory(prdDir, key);
        } catch (err) {
          log(
            `PRD ${prd.id}: created story ${key} in JIRA but failed to write its jira_story backref — the next reconcile will create a duplicate story unless the backref is added by hand: ${errorMessage(err)}`,
          );
          continue;
        }
        // A fresh Story lands in JIRA's initial column (the "To Do"/backlog bucket);
        // record that as its last-known status so the diff below only transitions
        // when the lane's target differs — and so the backref write-back's self-scan
        // finds it already cached and does nothing (a zero-JIRA no-op, ADR 0029).
        cache.set(key, statusNames.backlog);
        created.push({ prd: prd.id, key });

        // Placement is set **once at create** and never re-evaluated (the team owns
        // sprint moves — user story 8), so it lives inside this create-only branch:
        // a linked Story (backref already present) is never re-placed. Under the
        // feature-card shape only the **Story** is placed — its Sub-tasks follow it
        // by JIRA's own rules (ADR 0032), so a Sub-task is never sprinted directly.
        // `target: backlog` needs no action (the Story is already in the backlog);
        // only `target: sprint` resolves the board's active sprint and assigns. A
        // missing active sprint (memoized resolver → undefined) or a failed
        // assignment is a logged no-op that leaves the Story in the backlog — never
        // a crash, so it can't erase the create that already succeeded. The active
        // sprint is resolved lazily and at most once per board for the whole pass
        // (shared cache, not per-PRD — user story 19: very few JIRA calls).
        if (placement === "sprint") {
          const storyKeyForSprint = key;
          const sprintId = await resolveSprintForBoard(boardId);
          if (sprintId !== undefined) {
            try {
              await queue.run(() =>
                deps.seam.assignToSprint(sprintId, storyKeyForSprint),
              );
              placed.push({ prd: prd.id, key, sprint: sprintId });
            } catch (err) {
              log(
                `story ${key}: could not be placed into sprint ${sprintId} — leaving in the backlog (no-op): ${errorMessage(err)}`,
              );
            }
          }
        }
      }

      // Self-heal, diff-gated (ADR 0028): drive the legal transition toward the
      // lane's target status only when the in-memory cache says the Story isn't
      // already there — no network read. Idempotent (a cache hit at target is a
      // no-op); an illegal/absent transition is a logged no-op (graceful
      // degradation), never a crash or a `human-review`.
      const target = storyTargetStatus(prd.lane, statusNames);
      if (
        await driveToTarget(key, target, queue, cache, deps, log, `story ${key}`)
      ) {
        transitioned.push({ key, to: target });
      }

      // The Story is now durably recorded (backref written or already present), so
      // its key can safely parent Sub-tasks — the Story-before-Sub-task ordering
      // (ADR 0032). Every path that leaves `key` unusable (no board, create failed,
      // backref-write failed) `continue`d above, so we only ever reach here with a
      // Story a Sub-task can be nested under. Each Issue reconciles independently: a
      // failure on one is its own logged no-op and never stops its siblings.
      //
      // Reconcile the PRD's Sub-tasks concurrently so their writes hit the paced
      // queue *as a batch* — that batching is the whole point of the queue for a
      // bulk first sync (many Sub-task creates) or a wide dispatch wave (many
      // transitions): the queue releases a bounded burst per tick rather than
      // firing the lot at once. Each Sub-task's own writes still go through the queue
      // in FIFO submission order, and the delta is rebuilt from `outcomes` in
      // board/Issue order below, so a scrambled completion order can't reorder it.
      const outcomes = await Promise.all(
        prd.issues.map((issue) =>
          reconcileChild(
            prd.id,
            prdDir,
            key,
            issue,
            deps,
            queue,
            statusNames,
            cache,
            log,
          ),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.created) childrenCreated.push(outcome.created);
        if (outcome.transitioned) childrenTransitioned.push(outcome.transitioned);
      }
    } catch (err) {
      // Any seam/file failure for one PRD is a logged no-op; the board is never
      // taken down and the remaining PRDs still reconcile (ADR 0028).
      log(`PRD ${prd.id}: mirror reconcile failed (no-op): ${errorMessage(err)}`);
    }
  }

  return { created, transitioned, childrenCreated, childrenTransitioned, placed };
}

/**
 * Build a resolver for a board's live active sprint id, its cache shared across
 * every PRD in one reconcile pass (not one resolver per PRD): two or more
 * `target: sprint` PRDs that mirror to the same board (their own `board` or a
 * common `default_board`) must make only one `resolveActiveSprint` acli call
 * between them, not one each — the whole pass makes at most one sprint read per
 * distinct board, however many PRDs share it (user story 19: very few JIRA
 * calls). Never throws: an unresolvable board (no `board` and no
 * `default_board`), a board with no active sprint, or an acli failure all
 * resolve (and cache) to `undefined` — a logged no-op that leaves the Story in
 * the backlog, exactly the graceful degradation the mirror promises (ADR 0028).
 */
function createSprintResolver(
  deps: MirrorReconcilerDeps,
  log: (message: string) => void,
): (boardId: string | undefined) => Promise<string | undefined> {
  const cache = new Map<string | undefined, Promise<string | undefined>>();
  return (boardId) => {
    let pending = cache.get(boardId);
    if (pending === undefined) {
      pending = resolveOnce(boardId);
      cache.set(boardId, pending);
    }
    return pending;
  };

  async function resolveOnce(
    boardId: string | undefined,
  ): Promise<string | undefined> {
    if (boardId === undefined) {
      log(
        "sprint placement wanted but the PRD names no board and no default_board is configured — leaving in backlog (no-op).",
      );
      return undefined;
    }
    try {
      const sprintId = await deps.seam.resolveActiveSprint(boardId);
      if (sprintId === undefined) {
        log(
          `board ${boardId} has no active sprint — leaving the story in the backlog (no-op).`,
        );
      }
      return sprintId;
    } catch (err) {
      log(
        `board ${boardId}: active sprint could not be resolved — leaving the story in the backlog (no-op): ${errorMessage(err)}`,
      );
      return undefined;
    }
  }
}

/**
 * Reconcile one Issue's mirrored Sub-task under its PRD's already-existing Story:
 * create-on-first-appearance (incl. a backlog Issue), write the `jira_key`
 * backref, then self-heal the Sub-task's status toward the Issue's authored status
 * (mapped to a JIRA bucket by {@link issueTargetStatus}). Mirrors the Story half's
 * shape one level down — idempotent create keyed on the backref (ADR 0029, so a
 * rename/renumber neither orphans nor duplicates), diff-gated self-heal against the
 * shared cache (ADR 0028, no network read), and every JIRA failure a logged no-op
 * (ADR 0028). A Sub-task is **never placed independently** — it follows its parent
 * Story's backlog/sprint by JIRA's own rules (ADR 0032), so sprint placement lives
 * one level up, on the Story.
 *
 * Wrapped in its own try/catch so one Issue's failure is isolated: the remaining
 * Issues of the PRD (and the other PRDs) still reconcile. Returns what it changed
 * (a create, a transition, or nothing) so the caller appends to the delta in
 * board/Issue order — no shared mutable accumulator threaded through.
 */
async function reconcileChild(
  prdId: string,
  prdDir: string,
  storyKey: string,
  issue: Issue,
  deps: MirrorReconcilerDeps,
  queue: PacedWriteQueue,
  statusNames: IssueStatusNames,
  cache: Map<string, string>,
  log: (message: string) => void,
): Promise<ChildOutcome> {
  const issuePath = join(prdDir, issue.id);
  try {
    const { status, body, childKey } = deps.readIssueMirror(issuePath);

    // Ensure the Sub-task exists: a present backref is update-or-noop (never a
    // second Sub-task — ADR 0029); an absent one creates then writes the backref.
    // The Sub-task's project is the Story's (a JIRA key is `PROJECT-NUMBER`), so a
    // Sub-task under an already-linked Story needs no extra board→project lookup.
    let key = childKey;
    let created: CreatedChild | undefined;
    if (key === undefined) {
      const description =
        body !== undefined && body.trim() !== "" ? body : undefined;
      key = await queue.run(() =>
        deps.seam.createChildIssue({
          project: projectFromKey(storyKey),
          parent: storyKey,
          summary: issue.title,
          ...(description !== undefined ? { description } : {}),
        }),
      );

      // Write the backref so the next pass is update-or-noop, not a duplicate
      // Sub-task (ADR 0029) — the same higher-stakes failure the Story half calls
      // out: a Sub-task created in JIRA whose backref never landed is re-created
      // every pass.
      try {
        deps.writeIssueKey(issuePath, key);
      } catch (err) {
        log(
          `Issue ${prdId}/${issue.id}: created sub-task ${key} in JIRA but failed to write its jira_key backref — the next reconcile will create a duplicate sub-task unless the backref is added by hand: ${errorMessage(err)}`,
        );
        return {};
      }
      // Record the fresh Sub-task's initial "To Do"/backlog landing status so the
      // diff-gate below only transitions when the authored status differs, and so
      // the backref write-back's self-scan finds it already cached (ADR 0029).
      cache.set(key, statusNames.backlog);
      created = { issue: issue.id, key };
    }

    // Self-heal the Sub-task's status toward the Issue's authored status. An
    // unreadable status, or one outside the ten authored values (a data error the
    // board would flag `malformedStatus`), skips the self-heal as a logged no-op —
    // the Sub-task still exists, it just isn't driven to a bogus column.
    if (status === undefined) {
      log(
        `sub-task ${key}: the Issue's status could not be read — skipping self-heal (no-op).`,
      );
      return { created };
    }
    const target = issueTargetStatus(status, statusNames);
    if (target === undefined) {
      log(
        `sub-task ${key}: authored status "${status}" maps to no JIRA bucket — skipping self-heal (no-op).`,
      );
      return { created };
    }
    // Diff-gated self-heal against the in-memory cache — no network read. A create
    // this pass has already cached the Sub-task's landing status, so an unchanged
    // Sub-task is a pure no-op; the transition (and its cache update) only fires when
    // the authored status crosses a bucket the cache doesn't already reflect.
    if (
      await driveToTarget(key, target, queue, cache, deps, log, `sub-task ${key}`)
    ) {
      return { created, transitioned: { key, to: target } };
    }
    return { created };
  } catch (err) {
    log(
      `Issue ${prdId}/${issue.id}: mirror reconcile failed (no-op): ${errorMessage(err)}`,
    );
    return {};
  }
}

/**
 * The diff-gate + self-heal for one work item (Story or Sub-task): transition `key`
 * to `target` **only** when the in-memory `cache` says it isn't already there (ADR
 * 0028). No network read — the cache is the sole source of the work item's last-known
 * status, seeded once on board-open and updated on every successful write.
 *
 * Returns `true` iff a transition was executed (the caller records the delta). A
 * cache hit at target is a silent no-op returning `false`; an illegal/absent
 * transition is a *logged* no-op returning `false` — never a throw, never a
 * `human-review` (the low-noise failure contract). On success the cache is advanced
 * to `target`, so the very next scan diff-gates the same board state to nothing.
 *
 * `label` is the log prefix (`"story DS-9"` / `"sub-task DS-50"`), the one detail
 * that differs between the two callers.
 */
async function driveToTarget(
  key: string,
  target: string,
  queue: PacedWriteQueue,
  cache: Map<string, string>,
  deps: MirrorReconcilerDeps,
  log: (message: string) => void,
  label: string,
): Promise<boolean> {
  const lastKnown = cache.get(key);
  if (lastKnown !== undefined && statusEquals(lastKnown, target)) return false;
  try {
    await queue.run(() => deps.seam.transition(key, target));
    cache.set(key, target);
    return true;
  } catch (err) {
    log(
      `${label}: transition to "${target}" is not available — leaving as-is (no-op): ${errorMessage(err)}`,
    );
    return false;
  }
}

/** What {@link reconcileChild} changed for one Issue: a create and/or a transition. */
interface ChildOutcome {
  readonly created?: CreatedChild;
  readonly transitioned?: ChildTransition;
}

/**
 * The project key a JIRA issue key belongs to — the substring before its trailing
 * `-NUMBER` (a key is `PROJECT-NUMBER`, e.g. `DS-100` → `DS`). Lets a Sub-task be
 * created in its Story's project without a second board→project lookup.
 */
function projectFromKey(key: string): string {
  return key.replace(/-\d+$/, "");
}

/**
 * The production file reader: parse a PRD's `prd.md` for its opt-in block and Story
 * backref via the shared `issueFile` contract. A missing/unreadable `prd.md`
 * (the PRD vanished mid-scan) reads as *not opted in*, so the reconciler skips it
 * rather than throwing — the same "a folder that vanished is just gone" contract
 * the scanner follows.
 */
export function readMirrorFile(prdDir: string): MirrorFileState {
  let raw: string;
  try {
    raw = readFileSync(join(prdDir, "prd.md"), "utf8");
  } catch {
    return {};
  }
  const { data } = safeMatter(raw);
  return {
    optIn: parseJiraOptIn(data),
    storyKey: readPresentString(data, FIELD.jiraStory),
  };
}

/** The production backref writer: write `jira_story` onto the PRD's `prd.md`. */
export function writeMirrorStory(prdDir: string, key: string): void {
  writeJiraStory(join(prdDir, "prd.md"), key);
}

/**
 * The production Issue-file reader: parse one Issue's `status`, its **body prose
 * with frontmatter stripped** (the Sub-task description), and its `jira_key`
 * Sub-task backref via the shared `issueFile` contract. A missing/unreadable Issue (it
 * vanished mid-scan, or a rename left the board's id stale) reads as all-absent,
 * so the reconciler skips it rather than throwing — the scanner's "a file that
 * vanished is just gone" contract.
 */
export function readIssueMirrorFile(issuePath: string): IssueMirrorState {
  let raw: string;
  try {
    raw = readFileSync(issuePath, "utf8");
  } catch {
    return {};
  }
  const { data, content } = safeMatter(raw);
  return {
    status: readString(data, FIELD.status),
    body: content,
    childKey: readPresentString(data, FIELD.jiraKey),
  };
}

/** The production Sub-task-backref writer: write `jira_key` onto the Issue file. */
export function writeMirrorIssueKey(issuePath: string, key: string): void {
  writeJiraKey(issuePath, key);
}

/**
 * The mirror's durable no-op/failure log, beside the dispatch log (ADR 0028: mirror
 * failures are log-only, never a board marker or status-line notice). Kept off the
 * board so a `⊘`/`⚠` operational signal never leaks to a JIRA stakeholder either.
 */
export function defaultMirrorLogPath(): string {
  return join(homedir(), ".local", "state", "overseer", "mirror.log");
}

/**
 * Append one mirror log line, best-effort. Never throws — a no-op the mirror
 * cannot even log is still a no-op, and this runs off the render loop where an
 * escaping error would be uncaught. Writing to a file (not stderr) keeps the Ink
 * alternate-screen board uncorrupted.
 */
export function appendMirrorLog(logPath: string, message: string): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()}\t${message}\n`);
  } catch {
    // Best-effort logging: nothing more to do if even the log write fails.
  }
}

/**
 * Build the production {@link MirrorReconciler} wired to the real acli seam, the
 * real `prd.md` reader/writer, and the durable mirror log — the one the CLI hands
 * to the scan loop. A thin convenience over {@link createMirrorReconciler} so the
 * wiring site need not name the default collaborators.
 */
export function realMirrorReconciler(opts: {
  readonly root: string;
  readonly defaultBoard?: string;
  readonly statusNames?: IssueStatusNames;
  readonly logPath?: string;
}): MirrorReconciler {
  const logPath = opts.logPath ?? defaultMirrorLogPath();
  return createMirrorReconciler({
    root: opts.root,
    seam: realJiraSeam,
    defaultBoard: opts.defaultBoard,
    statusNames: opts.statusNames,
    readMirror: readMirrorFile,
    writeStory: writeMirrorStory,
    readIssueMirror: readIssueMirrorFile,
    writeIssueKey: writeMirrorIssueKey,
    log: (message) => appendMirrorLog(logPath, message),
  });
}

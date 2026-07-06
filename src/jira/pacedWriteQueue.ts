/**
 * The paced write queue for the JIRA mirror's bulk fan-out (ADR 0028, user story
 * 20). Steady state the mirror makes a trickle of writes — the diff-gate already
 * decouples scan rate from write rate — so the one real rate-limit risk is a
 * *single* reconcile emitting a burst: the first sync of an already-populated PRD
 * (many child creates at once) or a wide dispatch wave (many transitions at once).
 * This queue drains that burst over a few seconds instead of firing it all at
 * once, so a busy pass never trips JIRA's rate limit.
 *
 * **Bounded fan-out per drain tick.** Every write the reconciler makes — epic and
 * child creates, status transitions, sprint assignments — is submitted through
 * {@link PacedWriteQueue.run}. The pump releases at most `burst` tasks, waits
 * `intervalMs`, releases the next `burst`, and so on, so no more than `burst`
 * writes are ever kicked off within one interval. Tasks are released in strict
 * FIFO submission order, which is how the reconciler preserves epic-before-child
 * ordering *through* the queue: it submits (and awaits) an epic's create before it
 * submits that epic's children, so the child creates only ever enter the queue
 * once their parent exists.
 *
 * **Fire-and-forget, never blocks the board.** The reconcile that feeds this queue
 * runs off the render loop (ADR 0028) and the board never awaits it; a half-drained
 * queue simply means JIRA is a few seconds behind, which the mirror already accepts
 * (it is stale whenever the TUI is closed). Each task's own promise still resolves
 * (or rejects) with its result, so the reconciler can await an individual write
 * where it needs the outcome — the epic key to parent children, say — without the
 * board ever waiting on the pass as a whole.
 */
export interface PacedWriteQueue {
  /**
   * Submit one write, resolving to its result once the pump releases and runs it.
   * Rejections propagate to the returned promise so the reconciler's per-write
   * try/catch degrades a failed acli call to a logged no-op exactly as before.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** How the paced queue drains: at most `burst` tasks per `intervalMs` tick. */
export interface PacedWriteQueueOptions {
  /** Max tasks released per drain tick (the burst ceiling). Clamped to `>= 1`. */
  readonly burst: number;
  /** Milliseconds the pump waits between ticks. Clamped to `>= 0`. */
  readonly intervalMs: number;
  /**
   * How the pump waits between ticks — injectable so a test can advance the queue
   * one tick at a time with a hand-cranked clock. Defaults to a real `setTimeout`.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a {@link PacedWriteQueue} that drains at most `burst` tasks per
 * `intervalMs` tick. The pump is lazy — it starts on the first `run` and stops the
 * moment the backlog empties (it never sleeps on an already-empty queue, so a
 * burst that fits in one tick adds no trailing delay) — and restarts when the next
 * write arrives.
 */
export function createPacedWriteQueue(
  opts: PacedWriteQueueOptions,
): PacedWriteQueue {
  const burst = Math.max(1, Math.floor(opts.burst));
  const intervalMs = Math.max(0, opts.intervalMs);
  const sleep = opts.sleep ?? realSleep;

  // Each entry, once released, starts its wrapped task and settles its caller's
  // promise. Held in FIFO order so releases (and therefore the acli calls they
  // make) preserve submission order — the reconciler's epic-before-child guarantee.
  const pending: Array<() => void> = [];
  let pumping = false;
  let scheduled = false;

  async function pump(): Promise<void> {
    pumping = true;
    try {
      while (pending.length > 0) {
        // Release up to `burst` tasks this tick; they run concurrently from here.
        for (const release of pending.splice(0, burst)) release();
        // Only pay the interval when there is more to drain — an emptied queue
        // never sleeps, so a single-batch burst finishes without a trailing wait.
        if (pending.length > 0) await sleep(intervalMs);
      }
    } finally {
      pumping = false;
    }
  }

  // Start the pump on a microtask, not synchronously: a reconcile submits a whole
  // burst of writes in one synchronous stretch (a PRD's child creates, a wave's
  // transitions), and the pump must see them *all* in `pending` before its first
  // splice — otherwise it would drain each lone write the instant it arrived and
  // never bound the fan-out. Deferring one microtask lets the batch gather first.
  function schedulePump(): void {
    if (pumping || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void pump();
    });
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push(() => {
          task().then(resolve, reject);
        });
        schedulePump();
      });
    },
  };
}

/**
 * A degenerate {@link PacedWriteQueue} that runs each task straight through with no
 * pacing at all — the identity pass-through. Handy for unit tests that assert the
 * reconciler's *ordering* and delta set without the timing dimension, keeping those
 * tests free of a clock.
 */
export function createImmediateWriteQueue(): PacedWriteQueue {
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return task();
    },
  };
}

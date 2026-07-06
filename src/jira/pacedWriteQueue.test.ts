import { describe, it, expect } from "vitest";
import {
  createPacedWriteQueue,
  createImmediateWriteQueue,
} from "./pacedWriteQueue.js";

/**
 * A hand-cranked stand-in for the real `setTimeout` sleep, so a test can advance
 * the queue one drain tick at a time and assert exactly how much fan-out each tick
 * released — no real timers, no flakiness. Each `sleep()` parks a resolver;
 * `tick()` releases every sleep currently parked (the pump only ever has one
 * outstanding at a time, so one `tick()` == one interval elapsed).
 */
function manualClock() {
  let parked: Array<() => void> = [];
  return {
    sleep: (): Promise<void> =>
      new Promise<void>((resolve) => parked.push(resolve)),
    tick: (): void => {
      const due = parked;
      parked = [];
      for (const resolve of due) resolve();
    },
  };
}

/** Yield to the event loop so parked continuations run before we assert. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("pacedWriteQueue — bounded fan-out per drain tick", () => {
  it("releases at most `burst` tasks per tick, spacing the rest by the interval", async () => {
    const clock = manualClock();
    const queue = createPacedWriteQueue({
      burst: 2,
      intervalMs: 1000,
      sleep: clock.sleep,
    });
    const started: number[] = [];
    // Six tasks that never resolve on their own — we only care *when* each starts,
    // which is what the pacer controls (the burst risk is the fan-out, not the
    // individual round-trip duration).
    const results = Array.from({ length: 6 }, (_v, i) =>
      queue.run(async () => {
        started.push(i);
      }),
    );

    // First tick: only the first burst starts; the rest are still parked.
    await flush();
    expect(started).toEqual([0, 1]);

    // Each subsequent interval releases exactly one more burst, in FIFO order.
    clock.tick();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);

    clock.tick();
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);

    await Promise.all(results);
  });

  it("resolves each task with its own result and surfaces rejections", async () => {
    const queue = createPacedWriteQueue({
      burst: 5,
      intervalMs: 0,
      sleep: async () => {},
    });

    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
    await expect(
      queue.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("does not wait after the final batch (an empty queue never sleeps)", async () => {
    let sleeps = 0;
    const queue = createPacedWriteQueue({
      burst: 2,
      intervalMs: 1000,
      sleep: async () => {
        sleeps += 1;
      },
    });

    // Exactly `burst` tasks fit in one tick, so the pump drains them and stops
    // without ever sleeping — no trailing interval on an emptied queue.
    await Promise.all([
      queue.run(async () => {}),
      queue.run(async () => {}),
    ]);
    expect(sleeps).toBe(0);
  });
});

describe("immediateWriteQueue", () => {
  it("runs each task straight through, unpaced", async () => {
    const queue = createImmediateWriteQueue();
    const order: string[] = [];
    await queue.run(async () => {
      order.push("a");
    });
    await queue.run(async () => {
      order.push("b");
    });
    expect(order).toEqual(["a", "b"]);
    await expect(queue.run(async () => 42)).resolves.toBe(42);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { watchRoot, DEBOUNCE_MS } from "./watcher.js";

/**
 * A stand-in for a chokidar watcher: an EventEmitter that also records whether
 * it was closed. Lets us drive fs events synchronously and assert teardown,
 * with no real filesystem or timing involved.
 */
class FakeWatcher extends EventEmitter {
  closed = false;
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  /** Emit a chokidar-style change event. */
  fire(): void {
    this.emit("all", "change", "/some/path");
  }
}

let watcher: FakeWatcher;
/** A factory matching watchRoot's injection seam, returning our fake. */
const createWatcher = () => watcher;

beforeEach(() => {
  vi.useFakeTimers();
  watcher = new FakeWatcher();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchRoot", () => {
  it("coalesces a burst of fs events within the debounce window into one onChange", () => {
    const onChange = vi.fn();
    watchRoot("/root", onChange, { createWatcher });

    // A storm of events — an atomic save, an agent writing several files.
    watcher.fire();
    watcher.fire();
    watcher.fire();

    expect(onChange).not.toHaveBeenCalled(); // still within the window
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

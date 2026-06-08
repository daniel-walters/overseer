import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("fires separate onChange calls for events spaced beyond the window", () => {
    const onChange = vi.fn();
    watchRoot("/root", onChange, { createWatcher });

    watcher.fire();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    // A later, unrelated edit once the board has settled.
    watcher.fire();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("stops firing onChange after teardown, even with a callback pending", () => {
    const onChange = vi.fn();
    const teardown = watchRoot("/root", onChange, { createWatcher });

    watcher.fire(); // arm the debounce
    teardown(); // tear down before the window elapses
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes the underlying watcher on teardown", () => {
    const teardown = watchRoot("/root", vi.fn(), { createWatcher });

    teardown();

    expect(watcher.closed).toBe(true);
  });
});

/**
 * One end-to-end pass against a real temp directory and real chokidar, with
 * real timers, to prove the default wiring (event name, ignoreInitial) actually
 * delivers a debounced onChange on a genuine filesystem change.
 */
describe("watchRoot (real filesystem)", () => {
  let root: string;
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    root = mkdtempSync(join(tmpdir(), "overseer-watch-"));
  });

  afterEach(() => {
    teardown?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("fires onChange after a real file is written, then settles", async () => {
    const changed = new Promise<void>((resolve) => {
      teardown = watchRoot(root, resolve);
    });

    // Give chokidar a moment to attach before mutating the tree.
    await new Promise((r) => setTimeout(r, 100));
    mkdirSync(join(root, "auth-system"));
    writeFileSync(join(root, "auth-system", "prd.md"), "---\nstatus: backlog\n---\n");

    await changed; // resolves only if the debounced onChange fired
  });
});

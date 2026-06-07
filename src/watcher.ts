import chokidar from "chokidar";

/**
 * How long the root must be quiet after the last filesystem event before we
 * fire `onChange`. Coalesces save-bursts and rename/atomic-save event storms
 * (an editor's atomic save, an agent writing several files) into one refresh.
 */
export const DEBOUNCE_MS = 150;

/** The minimal slice of a chokidar watcher this module depends on. */
export interface Watcher {
  on(event: "all", listener: (...args: unknown[]) => void): unknown;
  close(): Promise<void>;
}

export interface WatchOptions {
  /** Override the watcher factory in tests; defaults to chokidar. */
  createWatcher?: (root: string) => Watcher;
}

/**
 * Watch `root` and call `onChange` after each burst of filesystem activity
 * settles (a {@link DEBOUNCE_MS} debounce). Returns a teardown that stops the
 * watcher and cancels any pending callback.
 *
 * Kept separate from the scanner so the pure path → Board scan stays free of
 * timing and event concerns: a debounced event simply means "re-scan now".
 */
export function watchRoot(
  root: string,
  onChange: () => void,
  options: WatchOptions = {},
): () => void {
  const create = options.createWatcher ?? defaultCreateWatcher;
  const watcher = create(root);

  let timer: ReturnType<typeof setTimeout> | undefined;

  watcher.on("all", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, DEBOUNCE_MS);
  });

  return () => {
    if (timer) clearTimeout(timer);
    void watcher.close();
  };
}

/** Real chokidar watcher: ignore the initial add storm; the first scan is eager. */
function defaultCreateWatcher(root: string): Watcher {
  return chokidar.watch(root, { ignoreInitial: true });
}

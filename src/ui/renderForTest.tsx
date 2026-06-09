import { EventEmitter } from "node:events";
import type { ReactElement } from "react";
import { render as inkRender } from "ink";

/**
 * A render helper for Ink component tests, mirroring `ink-testing-library` but
 * with a configurable terminal width. The library hardcodes 100 columns, which
 * is too narrow for the Issue-level board's eight lanes (Unsorted + seven status
 * columns at width 24): the columns flex-shrink and truncate card titles. These
 * layout tests assert on full, untruncated titles and headings, so they need a
 * viewport wide enough to hold the real design — wider than any real terminal a
 * user would run the board in, which is the point.
 */
const DEFAULT_COLUMNS = 240;

class Stdout extends EventEmitter {
  readonly columns: number;
  frames: string[] = [];
  private _lastFrame = "";

  constructor(columns: number) {
    super();
    this.columns = columns;
  }

  write = (frame: string): void => {
    this.frames.push(frame);
    this._lastFrame = frame;
  };

  lastFrame = (): string | undefined => this._lastFrame;
}

class Stdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;

  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

/** Render an Ink element at a wide terminal, returning the testing handles. */
export function renderForTest(
  tree: ReactElement,
  columns: number = DEFAULT_COLUMNS,
) {
  const stdout = new Stdout(columns);
  const stdin = new Stdin();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    rerender: instance.rerender,
    unmount: instance.unmount,
    cleanup: instance.cleanup,
    stdin,
    frames: stdout.frames,
    lastFrame: stdout.lastFrame,
  };
}

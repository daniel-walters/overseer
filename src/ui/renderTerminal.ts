// `@xterm/headless` is a CommonJS package whose exports are assigned dynamically,
// so Node's ESM loader can't statically detect the named `Terminal` export. Import
// the module's default (its `module.exports`) and destructure `Terminal` from it.
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

/**
 * The bytes→screen transform behind the `o` agent-output modal (ADR 0030): given a
 * raw `claude logs <handle>` byte stream — a **TTY replay** of the agent's own
 * (Claude Code) full-screen TUI, full of carriage-return redraws, cursor moves, and
 * erase sequences — reconstruct the coherent screen a terminal would show and return
 * it as clean, line-oriented text.
 *
 * The stream carries no reliable record of the width the agent originally ran at, so
 * the caller sizes the grid to the modal's inner width; foreign-width content wraps
 * imperfectly, which is accepted (ADR 0030).
 */
export type TerminalRenderer = (
  bytes: string,
  cols: number,
  rows: number,
) => Promise<readonly string[]>;

/**
 * Preserve well beyond the modal's viewport so content taller than the grid keeps
 * scrolling in `buffer.active` rather than being lost — the reader's own buffer cap
 * bounds the volume, and `claude logs` returns only a recent snapshot, so this can
 * never grow unbounded.
 */
const SCROLLBACK_LINES = 10_000;

/**
 * Run raw TTY-replay bytes through a headless `@xterm/headless` terminal sized to
 * `cols`×`rows`, let the in-place redraws (carriage returns, cursor-up spinner
 * frames, erase sequences) resolve against the grid, then read the final buffer back
 * as clean lines — the "what does the agent's terminal show right now" screen the
 * observation feature exists to surface.
 *
 * This is the *only* module that imports the emulator (ADR 0030): bytes in, resolved
 * screen lines out, nothing of `@xterm/headless` leaking past this signature.
 *
 * `@xterm/headless`'s `write()` flushes its parse buffer on a callback, so the
 * resolved screen can only be read once that callback fires — hence the `Promise`,
 * which is what makes the `o`-open path in {@link import("./App.js").App} asynchronous.
 *
 * `convertEol` maps a bare `\n` to `\r\n` so plain multi-line text (which uses line
 * feeds without carriage returns) lands at column 0 rather than staircasing across
 * the grid; a stream that already carries `\r\n` is unaffected. Each buffer line is
 * read with `translateToString(true)` (trailing blanks trimmed), and trailing
 * whitespace-only lines are dropped so empty or whitespace-only input yields no real
 * content — the signal the modal's `(no output yet)` placeholder keys off.
 *
 * `write()`'s callback fires asynchronously, after `write()` itself has already
 * returned — so a throw inside it lands outside the `Promise` constructor's own
 * synchronous try/catch and would otherwise become an uncaught exception that
 * crashes the whole process, not a rejection {@link import("./App.js").App}'s
 * `.catch` can degrade gracefully. The body is wrapped so any such failure (a bug in
 * the buffer read, or in `@xterm/headless` itself) rejects instead.
 */
export const renderTerminal: TerminalRenderer = (bytes, cols, rows) =>
  new Promise((resolve, reject) => {
    const term = new Terminal({
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
      scrollback: SCROLLBACK_LINES,
      convertEol: true,
      allowProposedApi: true,
    });
    term.write(bytes, () => {
      try {
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
          lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
        }
        // Drop trailing blank rows the fixed grid always carries below the last real
        // content, so a snapshot ending in empty rows neither inflates the scroll
        // range nor masks the placeholder for empty/whitespace-only input.
        while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length === 0) {
          lines.pop();
        }
        term.dispose();
        resolve(lines);
      } catch (err) {
        term.dispose();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });

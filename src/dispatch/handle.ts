/**
 * Parse the agent handle from a `claude --bg` launch.
 *
 * `claude --bg` emits a human-facing line `backgrounded · <handle>` on stdout;
 * that `<handle>` is the same string that appears as a session row's `id` in
 * `claude agents --json`, so it is Overseer's join key from a live agent back to
 * its Issue (ADR 0008). There is no structured launch output under `--bg`, so
 * this brittle parse is the only way to obtain the handle — isolated here so the
 * one fragile thing is small, pure, and independently testable.
 */

/** The middle-dot separator (U+00B7) Claude prints between the label and the handle. */
const HANDLE_LINE = /^backgrounded\s+·\s+(\S+)/;

/**
 * SGR/CSI colour escapes (`\x1b[...m`). Now that `--bg` stdout is captured through
 * a pipe rather than discarded, `claude` may still emit colour (a non-TTY pipe
 * doesn't always disable it, and `FORCE_COLOR` overrides it): a stray escape
 * before `backgrounded` would defeat the `^` anchor, and one glued after the
 * handle would be captured into it — recording a coloured handle that never joins
 * the clean `id` from `claude agents --json`. Stripping escapes first makes the
 * parse robust to either. (Built from `String.fromCharCode` so no control char
 * appears in the source.)
 */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Extract the agent handle from a `claude --bg` launch's stdout, or `undefined`
 * when no `backgrounded · <handle>` line is present (malformed or empty stdout).
 * Returning `undefined` rather than throwing keeps the spawn edge total: a launch
 * that printed something unexpected still flips the Issue and runs an agent — it
 * just leaves an unrecorded handle, which degrades to "unknown" liveness, never a
 * crash (ADR 0008).
 */
export function parseHandle(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const match = HANDLE_LINE.exec(line.replace(ANSI_ESCAPE, "").trim());
    if (match) return match[1];
  }
  return undefined;
}

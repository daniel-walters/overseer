import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import type { UrlOpener } from "./App.js";

/**
 * The production {@link UrlOpener}: open a url in the user's default browser by
 * shelling out to the platform's open command (`open` on macOS, `xdg-open` on
 * Linux/BSD, `cmd /c start` on Windows). This is the un-fakeable shell-out
 * boundary the `go to PR` keybind reaches GitHub through — kept thin and excluded
 * from unit tests exactly as the `realPrSeam` / `GitSeam` shell-outs are; the
 * keybind's gating logic (fire only when the Linked PR overlay reports a PR) is
 * the testable part and lives in the App, driven by an in-memory fake opener.
 *
 * A failure to launch the opener (no such command, a detached session with no
 * browser) is swallowed: `go to PR` is a pure navigation convenience, so a failed
 * open must never crash the board or throw out of the input handler — at worst the
 * browser simply doesn't appear, the same honest degradation the read overlay has.
 */
export const realUrlOpener: UrlOpener = {
  open(url: string): void {
    const { command, prefix } = openCommand();
    try {
      execFileSync(command, [...prefix, url], { stdio: "ignore" });
    } catch {
      // The opener couldn't be launched (missing command, headless session): a
      // navigation convenience failing is not worth a crash — degrade silently.
    }
  },
};

/**
 * The platform's "open this in the default handler" command: the `command` to run
 * plus any `prefix` args that precede the url. Windows routes through `cmd /c
 * start ""` (the empty title argument keeps a url with spaces from being mistaken
 * for the window title); macOS uses `open`; everything else assumes a freedesktop
 * `xdg-open`.
 */
function openCommand(): { command: string; prefix: readonly string[] } {
  switch (platform()) {
    case "darwin":
      return { command: "open", prefix: [] };
    case "win32":
      return { command: "cmd", prefix: ["/c", "start", ""] };
    default:
      return { command: "xdg-open", prefix: [] };
  }
}

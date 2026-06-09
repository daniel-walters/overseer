#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import meow from "meow";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, ConfigError } from "./config.js";
import { scanBoard } from "./scanner.js";
import { watchRoot } from "./watcher.js";
import { LiveApp } from "./ui/LiveApp.js";
import { createDispatcher } from "./dispatch/dispatcher.js";
import { createReviewer } from "./review/reviewer.js";
import { createReactor } from "./reactor/reactor.js";
import { realGitSeam } from "./dispatch/gitSetup.js";
import { createSpawnEdge, realExec, defaultLogPath } from "./dispatch/spawn.js";
import { runInit } from "./init/runInit.js";

const HELP = `
  Usage
    $ overseer            Render the live kanban board
    $ overseer init       Install bundled skills into the global Claude skills dir

  Options
    --help                Show this help
    --version             Show the installed version
`;

/** Print a user-facing error and exit non-zero — never returns. */
function fail(message: string): never {
  process.stderr.write(`overseer: ${message}\n`);
  process.exit(1);
}

/**
 * Load config → eager first `scanBoard` → render a {@link LiveApp} that re-scans
 * and re-renders on every debounced filesystem change, tearing the watcher down
 * when Ink unmounts.
 */
function runBoard(): void {
  let root: string;
  try {
    root = loadConfig().root;
  } catch (err) {
    if (err instanceof ConfigError) {
      fail(err.message);
    }
    throw err;
  }

  const initialBoard = scanBoard(root);
  // The real spawn edge: confirming a dispatch validates each repo, ensures the
  // PRD feature branch, flips Issues to in-progress (driving the live board),
  // and launches a background `claude --bg` agent per spawn candidate.
  const { spawn, logFailure } = createSpawnEdge({
    exec: realExec,
    logPath: defaultLogPath(),
  });
  const dispatcher = createDispatcher(root, {
    git: realGitSeam,
    spawn,
    logFailure,
  });
  // The reviewer reuses the very same `claude --bg` spawn edge — a reviewer is
  // just another background agent — flipping ready-for-review → in-review and
  // launching the reviewer in the Issue's repo.
  const reviewer = createReviewer(root, { spawn, logFailure });
  // The Reactor reuses the very same validated git/spawn/log machinery, so its
  // automated dispatches behave identically to a manual `d`. The live loop
  // reconciles it after each board rebuild, closing the re-dispatch loop: a
  // completed Issue unblocks its siblings and they spawn with no second keypress.
  const reactor = createReactor(root, { git: realGitSeam, spawn, logFailure });
  render(
    <LiveApp
      root={root}
      initialBoard={initialBoard}
      scan={scanBoard}
      watch={watchRoot}
      dispatcher={dispatcher}
      reviewer={reviewer}
      reactor={reactor}
    />,
  );
}

/**
 * Thin wiring: parse argv, then branch on the subcommand *before* `loadConfig`,
 * so `init` works with no config present. With no subcommand, render the board.
 *
 * Any filesystem/environment failure from `init` (an unwritable skills dir, a
 * path occupied by a file, a missing shipped `skills/`) is surfaced as a clean
 * `overseer: …` message + non-zero exit — the same contract the board path uses
 * for {@link ConfigError} — rather than an uncaught stack trace.
 */
function main(): void {
  const cli = meow(HELP, { importMeta: import.meta });

  const subcommand = cli.input[0];
  if (subcommand === "init") {
    try {
      runInit({ entryUrl: import.meta.url });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (subcommand !== undefined) {
    fail(`unknown command '${subcommand}'. Run 'overseer --help' for usage.`);
  }
  runBoard();
}

/**
 * Run `main` only when this file is executed directly (the `overseer` bin), not
 * when it is imported — so importing the module has no argv-parsing, rendering,
 * or skill-installing side effects. Resolves symlinks (the npm `bin` shim) so
 * the comparison holds for a globally-installed package.
 */
function runningAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (runningAsScript()) {
  main();
}

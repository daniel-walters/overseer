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
import { createAgentSidecar, defaultSidecarPath } from "./dispatch/agentSidecar.js";
import {
  createLivenessProbe,
  realLivenessQuery,
} from "./dispatch/liveness.js";
import type { Board } from "./model.js";
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

  // The real spawn edge: confirming a dispatch validates each repo, ensures the
  // PRD feature branch, flips Issues to in-progress (driving the live board),
  // and launches a background `claude --bg` agent per spawn candidate.
  const { spawn, logFailure } = createSpawnEdge({
    exec: realExec,
    logPath: defaultLogPath(),
  });
  // The sidecar persists each spawned agent's captured `--bg` handle as
  // `issueKey → handle` outside the watched root (ADR 0008), so a later board
  // open can join a live `claude agents --json` row back to its Issue. Shared by
  // all three spawn paths (manual `d`/`r` and the Reactor) so every launched
  // agent is recorded identically; `read` feeds the liveness probe below.
  const { record: recordHandle, read: readHandles } =
    createAgentSidecar(defaultSidecarPath());
  // The liveness probe (ADR 0008 / 0009): on each call it re-queries
  // `claude agents --json`, re-reads the recorded handles, and intersects them
  // into a per-Issue trust-qualified absence (live / absent-clean /
  // absent-degraded). The scanner maps that onto the card-level verdict behind
  // the active-lane gate. Wrapping `scanBoard` so the overlay is recomputed on
  // every rebuild keeps liveness a derived overlay, never persisted into the
  // Issue files (ADR 0002) — a handle that drops out flips to absent on the next
  // scan. `scanWithLiveness` is used for both the eager first render and the live
  // re-scan, so the board carries liveness from the very first frame.
  const probe = createLivenessProbe({
    query: realLivenessQuery,
    readHandles,
  });
  const scanWithLiveness = (r: string): Board => {
    const verdicts = probe();
    return scanBoard(r, (issuePath) => verdicts[issuePath]);
  };
  const initialBoard = scanWithLiveness(root);
  const dispatcher = createDispatcher(root, {
    git: realGitSeam,
    spawn,
    logFailure,
    recordHandle,
  });
  // The reviewer reuses the very same `claude --bg` spawn edge — a reviewer is
  // just another background agent — flipping ready-for-review → in-review and
  // launching the reviewer in the Issue's repo.
  const reviewer = createReviewer(root, { spawn, logFailure, recordHandle });
  // The Reactor reuses the very same validated git/spawn/log machinery, so its
  // automated dispatches behave identically to a manual `d`. The live loop
  // reconciles it after each board rebuild, closing the re-dispatch loop: a
  // completed Issue unblocks its siblings and they spawn with no second keypress.
  const reactor = createReactor(root, {
    git: realGitSeam,
    spawn,
    logFailure,
    recordHandle,
  });
  // Render on the terminal's alternate screen buffer (like vim/htop/less): the
  // board takes over the whole screen on launch and the user's prior shell
  // contents are restored untouched on quit. Ink manages enter/exit and restore.
  // Every fail-fast check above (loadConfig, the eager scanWithLiveness) runs
  // *before* this call, so a config/scan error still prints on the normal screen
  // rather than onto the alt buffer, where it would be wiped on restore. The
  // liveness query inside that eager scan is bounded (timeout + maxBuffer) and
  // degrades to unknown on any failure, so it neither hangs startup nor throws
  // here.
  render(
    <LiveApp
      root={root}
      initialBoard={initialBoard}
      scan={scanWithLiveness}
      watch={watchRoot}
      dispatcher={dispatcher}
      reviewer={reviewer}
      reactor={reactor}
    />,
    { alternateScreen: true },
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

#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import meow from "meow";
import { loadConfig, ConfigError } from "./config.js";
import { scanBoard } from "./scanner.js";
import { watchRoot } from "./watcher.js";
import { LiveApp } from "./ui/LiveApp.js";
import { createDispatcher } from "./dispatch/dispatcher.js";
import { realGitSeam } from "./dispatch/gitSetup.js";
import { createSpawnEdge, realExec, defaultLogPath } from "./dispatch/spawn.js";
import { runInit } from "./init/runInit.js";

const cli = meow(
  `
  Usage
    $ overseer            Render the live kanban board
    $ overseer init       Install bundled skills into the global Claude skills dir

  Options
    --help                Show this help
    --version             Show the installed version
`,
  { importMeta: import.meta },
);

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
      process.stderr.write(`overseer: ${err.message}\n`);
      process.exit(1);
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
  render(
    <LiveApp
      root={root}
      initialBoard={initialBoard}
      scan={scanBoard}
      watch={watchRoot}
      dispatcher={dispatcher}
    />,
  );
}

/**
 * Thin wiring: branch on the subcommand *before* `loadConfig`, so `init` works
 * with no config present. With no subcommand, render the board exactly as today.
 */
function main(): void {
  if (cli.input[0] === "init") {
    runInit({ entryUrl: import.meta.url });
    return;
  }
  runBoard();
}

main();

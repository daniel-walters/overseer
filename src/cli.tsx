#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { loadConfig, ConfigError } from "./config.js";
import { scanBoard } from "./scanner.js";
import { watchRoot } from "./watcher.js";
import { LiveApp } from "./ui/LiveApp.js";
import { createDispatcher } from "./dispatch/dispatcher.js";
import { realGitSeam } from "./dispatch/gitSetup.js";
import { createSpawnEdge, realExec, defaultLogPath } from "./dispatch/spawn.js";

/**
 * Thin wiring: load config → eager first `scanBoard` → render a {@link LiveApp}
 * that re-scans and re-renders on every debounced filesystem change, tearing
 * the watcher down when Ink unmounts.
 */
function main(): void {
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

main();

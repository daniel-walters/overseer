#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { loadConfig, ConfigError } from "./config.js";
import { scanBoard } from "./scanner.js";
import { watchRoot } from "./watcher.js";
import { LiveApp } from "./ui/LiveApp.js";
import { createDispatcher } from "./dispatch/dispatcher.js";
import { spawnStub } from "./dispatch/spawnStub.js";

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
  // The spawn tip is stubbed this iteration: dispatch flips Issues to
  // in-progress (driving the live board) but launches no real agents yet.
  const dispatcher = createDispatcher(root, spawnStub);
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

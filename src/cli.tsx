#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { loadConfig, ConfigError } from "./config.js";
import { scanBoard } from "./scanner.js";
import { App } from "./ui/App.js";

/**
 * Thin wiring: load config → scan the root into a Board → render it with Ink.
 * Watching and live refresh arrive in a later slice.
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

  const board = scanBoard(root);
  render(<App board={board} />);
}

main();

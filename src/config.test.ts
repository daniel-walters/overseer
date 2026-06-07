import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "./config.js";

let home: string;
let configPath: string;

beforeEach(() => {
  // A throwaway HOME so `~` expansion is deterministic and isolated.
  home = mkdtempSync(join(tmpdir(), "overseer-home-"));
  configPath = join(home, ".config", "overseer", "config.toml");
  mkdirSync(join(home, ".config", "overseer"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("reads root from the config file and expands a leading ~", () => {
    mkdirSync(join(home, "work", "prds"), { recursive: true });
    writeFileSync(configPath, 'root = "~/work/prds"\n');

    const config = loadConfig({ configPath, home });

    expect(config.root).toBe(join(home, "work", "prds"));
  });

  it("throws a ConfigError when the config file is missing", () => {
    expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
  });

  it("throws a ConfigError when the configured root does not exist", () => {
    writeFileSync(configPath, 'root = "~/does/not/exist"\n');

    expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
  });
});

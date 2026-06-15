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

  it("expands a bare ~ to the home directory", () => {
    writeFileSync(configPath, 'root = "~"\n');

    const config = loadConfig({ configPath, home });

    expect(config.root).toBe(home);
  });

  it("leaves an absolute root path untouched", () => {
    const abs = mkdtempSync(join(tmpdir(), "overseer-root-"));
    try {
      writeFileSync(configPath, `root = "${abs}"\n`);

      expect(loadConfig({ configPath, home }).root).toBe(abs);
    } finally {
      rmSync(abs, { recursive: true, force: true });
    }
  });

  it("throws a ConfigError naming the path when the config file is missing", () => {
    expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath, home })).toThrow(configPath);
  });

  it("throws a ConfigError when the config file is not valid TOML", () => {
    writeFileSync(configPath, "this is not = = toml\n");

    expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath, home })).toThrow(/not valid TOML/i);
  });

  it("throws a ConfigError when root is missing from the config", () => {
    writeFileSync(configPath, 'other = "value"\n');

    expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath, home })).toThrow(/root/i);
  });

  it("throws a distinct ConfigError when the configured root does not exist", () => {
    writeFileSync(configPath, 'root = "~/does/not/exist"\n');

    expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath, home })).toThrow(
      /does not exist/i,
    );
    // The message names the expanded path so the user can act on it.
    expect(() => loadConfig({ configPath, home })).toThrow(
      join(home, "does", "not", "exist"),
    );
  });

  it("throws a ConfigError when the configured root is a file, not a directory", () => {
    const file = join(home, "a-file");
    writeFileSync(file, "i am a file\n");
    writeFileSync(configPath, 'root = "~/a-file"\n');

    expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath, home })).toThrow(/not a directory/i);
  });

  describe("review knobs", () => {
    /** Write a valid root plus the given extra TOML body. */
    function writeWithRoot(extra: string): void {
      writeFileSync(configPath, `root = "~"\n${extra}`);
    }

    it("defaults the review cap to 3 and effort to medium when the table is absent", () => {
      writeFileSync(configPath, 'root = "~"\n');

      const config = loadConfig({ configPath, home });

      expect(config.review.cap).toBe(3);
      expect(config.review.effort).toBe("medium");
    });

    it("reads the review cap from the [review] table", () => {
      writeWithRoot("[review]\ncap = 5\n");

      expect(loadConfig({ configPath, home }).review.cap).toBe(5);
    });

    it("reads the review effort from the [review] table", () => {
      writeWithRoot('[review]\neffort = "high"\n');

      expect(loadConfig({ configPath, home }).review.effort).toBe("high");
    });

    it("falls back to the cap default when only effort is set", () => {
      writeWithRoot('[review]\neffort = "low"\n');

      const config = loadConfig({ configPath, home });

      expect(config.review.cap).toBe(3);
      expect(config.review.effort).toBe("low");
    });

    it("falls back to the effort default when only the cap is set", () => {
      writeWithRoot("[review]\ncap = 7\n");

      const config = loadConfig({ configPath, home });

      expect(config.review.cap).toBe(7);
      expect(config.review.effort).toBe("medium");
    });

    it("throws a ConfigError when the cap is not a number", () => {
      writeWithRoot('[review]\ncap = "lots"\n');

      expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
      expect(() => loadConfig({ configPath, home })).toThrow(/cap/i);
    });

    it("throws a ConfigError when the cap is not a positive integer", () => {
      writeWithRoot("[review]\ncap = 0\n");

      expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
      expect(() => loadConfig({ configPath, home })).toThrow(/cap/i);
    });

    it("throws a ConfigError naming the allowed values for an unknown effort", () => {
      writeWithRoot('[review]\neffort = "extreme"\n');

      expect(() => loadConfig({ configPath, home })).toThrow(ConfigError);
      expect(() => loadConfig({ configPath, home })).toThrow(/effort/i);
      expect(() => loadConfig({ configPath, home })).toThrow(/medium/i);
    });
  });
});

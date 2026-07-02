import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfig } from "./ensureConfig.js";
import { loadConfig } from "../config.js";

let home: string;
let configPath: string;

beforeEach(() => {
  // A throwaway HOME so `~` expansion is deterministic and isolated.
  home = mkdtempSync(join(tmpdir(), "overseer-home-"));
  configPath = join(home, ".config", "overseer", "config.toml");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("ensureConfig", () => {
  it('writes a config with root = "~/overseer" when none exists', () => {
    const result = ensureConfig({ configPath, home, defaultRoot: "~/overseer" });

    expect(result.created).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toMatch(/root\s*=\s*"~\/overseer"/);
  });

  it("scaffolds the recommended Agent-runtime and review tables", () => {
    ensureConfig({ configPath, home, defaultRoot: "~/overseer" });

    const written = readFileSync(configPath, "utf8");
    expect(written).toMatch(/\[implementor\]\s+model = "opus"\s+effort = "high"/);
    expect(written).toMatch(
      /\[reviewer\]\s+model = "sonnet"\s+effort = "medium"/,
    );
    expect(written).toMatch(/\[review\]\s+cap = 3\s+effort = "medium"/);
  });

  it("writes a scaffolded config whose tables loadConfig resolves", () => {
    ensureConfig({ configPath, home, defaultRoot: "~/overseer" });

    const config = loadConfig({ configPath, home });

    expect(config.implementor).toEqual({ model: "opus", effort: "high" });
    expect(config.reviewer).toEqual({ model: "sonnet", effort: "medium" });
    expect(config.review).toEqual({ cap: 3, effort: "medium" });
  });

  it("creates the default root directory when none exists", () => {
    ensureConfig({ configPath, home, defaultRoot: "~/overseer" });

    expect(statSync(join(home, "overseer")).isDirectory()).toBe(true);
  });

  it("writes a config that loadConfig accepts (round-trip)", () => {
    ensureConfig({ configPath, home, defaultRoot: "~/overseer" });

    const config = loadConfig({ configPath, home });

    expect(config.root).toBe(join(home, "overseer"));
  });

  it("leaves an existing config byte-for-byte unchanged", () => {
    const existing = 'root = "~/my/custom/place"\n';
    mkdirSync(join(home, ".config", "overseer"), { recursive: true });
    writeFileSync(configPath, existing);

    const result = ensureConfig({ configPath, home, defaultRoot: "~/overseer" });

    expect(result.created).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(existing);
  });

  it("creates no default root when the config already exists", () => {
    mkdirSync(join(home, ".config", "overseer"), { recursive: true });
    writeFileSync(configPath, 'root = "~/elsewhere"\n');

    ensureConfig({ configPath, home, defaultRoot: "~/overseer" });

    expect(existsSync(join(home, "overseer"))).toBe(false);
  });

  it("reports created vs already-existed", () => {
    const first = ensureConfig({ configPath, home, defaultRoot: "~/overseer" });
    expect(first.created).toBe(true);

    const second = ensureConfig({ configPath, home, defaultRoot: "~/overseer" });
    expect(second.created).toBe(false);
  });
});

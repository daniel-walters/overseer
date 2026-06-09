import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installSkills } from "./installSkills.js";

/** The repo's shipped `skills/` directory (two levels up from `src/init`). */
const shippedSkills = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

describe("bundled skills", () => {
  it("installs overseer-merge from the shipped skills/ directory", () => {
    const target = mkdtempSync(join(tmpdir(), "overseer-bundled-"));
    try {
      const installed = installSkills({ source: shippedSkills, target });

      // The human-path merge skill must ship so `overseer init` installs it.
      expect(installed).toContain("overseer-merge");
      expect(existsSync(join(target, "overseer-merge", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

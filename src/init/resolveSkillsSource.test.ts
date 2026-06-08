import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { resolveSkillsSource } from "./resolveSkillsSource.js";

describe("resolveSkillsSource", () => {
  it("resolves skills/ one level up from the entry file's directory", () => {
    // Entry file lives in `<root>/dist/cli.js`; skills/ ships at `<root>/skills`.
    const entryUrl = pathToFileURL("/opt/pkg/dist/cli.js").href;

    expect(resolveSkillsSource(entryUrl)).toBe(join("/opt", "pkg", "skills"));
  });

  it("is independent of the current working directory", () => {
    const entryUrl = pathToFileURL("/opt/pkg/dist/cli.js").href;
    const expected = join("/opt", "pkg", "skills");

    const original = process.cwd();
    try {
      process.chdir("/");
      expect(resolveSkillsSource(entryUrl)).toBe(expected);
      process.chdir(original);
      expect(resolveSkillsSource(entryUrl)).toBe(expected);
    } finally {
      process.chdir(original);
    }
  });
});

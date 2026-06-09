import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumeratePrdDirs } from "./prds.js";

describe("enumeratePrdDirs", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-prds-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Make a directory under root, optionally with a `prd.md`. */
  function dir(name: string, withPrd: boolean): void {
    const path = join(root, name);
    mkdirSync(path);
    if (withPrd) writeFileSync(join(path, "prd.md"), "# prd");
  }

  it("lists directories that contain a prd.md", () => {
    dir("alpha", true);
    dir("beta", true);

    expect(enumeratePrdDirs(root).sort()).toEqual([
      join(root, "alpha"),
      join(root, "beta"),
    ]);
  });

  it("ignores directories without a prd.md", () => {
    dir("a-prd", true);
    dir("not-a-prd", false);

    expect(enumeratePrdDirs(root)).toEqual([join(root, "a-prd")]);
  });

  it("ignores non-directory entries (loose files in the root)", () => {
    dir("a-prd", true);
    writeFileSync(join(root, "README.md"), "# readme");
    writeFileSync(join(root, "prd.md"), "# a stray top-level prd file");

    expect(enumeratePrdDirs(root)).toEqual([join(root, "a-prd")]);
  });

  it("tolerates an unreadable/missing root, returning no PRDs", () => {
    expect(enumeratePrdDirs(join(root, "does-not-exist"))).toEqual([]);
  });
});

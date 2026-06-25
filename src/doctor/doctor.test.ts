import { describe, it, expect } from "vitest";
import {
  runDoctor,
  formatReport,
  MIN_NODE_MAJOR,
  type CommandProbe,
  type CheckResult,
  type DoctorReport,
} from "./doctor.js";
import { ConfigError, type Config } from "../config.js";

/** A config every field of which is present, so `loadConfig` "succeeds". */
const A_CONFIG = {
  root: "/work/prds",
  review: { cap: 3, effort: "medium" },
  implementor: { model: null, effort: null },
  reviewer: { model: null, effort: null },
} as Config;

/**
 * A probe driven by a `command → result` map: any command in the map returns its
 * canned result, anything else reads as "not found" (`ok: false`). The key is the
 * bare command name, so `gh --version` and `gh auth status` share the `gh` entry
 * unless overridden — most tests don't care, the gh-specific ones use {@link ghProbe}.
 */
function probeFrom(map: Record<string, { ok: boolean; output: string }>): CommandProbe {
  return (command) =>
    map[command] ?? { ok: false, output: `${command}: command not found` };
}

/** All three CLIs present and (for gh) authenticated — the all-green environment. */
const HEALTHY_PROBE: CommandProbe = probeFrom({
  claude: { ok: true, output: "1.2.3 (Claude Code)\n" },
  git: { ok: true, output: "git version 2.43.0\n" },
  gh: { ok: true, output: "gh version 2.40.0 (2024-01-01)\nhttps://github.com/cli/cli\n" },
});

function find(report: DoctorReport, name: string): CheckResult {
  const check = report.checks.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  return check;
}

describe("runDoctor — Node version", () => {
  it("passes on a current Node", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.3.0`,
      probe: HEALTHY_PROBE,
      loadConfig: () => A_CONFIG,
    });
    expect(find(report, "Node.js").status).toBe("ok");
  });

  it("fails on a too-old Node", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR - 1}.0.0`,
      probe: HEALTHY_PROBE,
      loadConfig: () => A_CONFIG,
    });
    const node = find(report, "Node.js");
    expect(node.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("warns (does not hard-fail) on an unparseable version", () => {
    const report = runDoctor({
      nodeVersion: "weird",
      probe: HEALTHY_PROBE,
      loadConfig: () => A_CONFIG,
    });
    const node = find(report, "Node.js");
    expect(node.status).toBe("warn");
    // A warn never fails the run.
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor — config", () => {
  it("reports the root on a valid config", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: HEALTHY_PROBE,
      loadConfig: () => A_CONFIG,
    });
    const config = find(report, "Configuration");
    expect(config.status).toBe("ok");
    expect(config.detail).toContain("/work/prds");
  });

  it("fails with the ConfigError message (plus an init hint) on a bad config", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: HEALTHY_PROBE,
      loadConfig: () => {
        throw new ConfigError("No config file at /x/config.toml.");
      },
    });
    const config = find(report, "Configuration");
    expect(config.status).toBe("fail");
    expect(config.detail).toContain("No config file at /x/config.toml.");
    expect(config.detail).toContain("overseer init");
    expect(report.ok).toBe(false);
  });

  it("propagates a non-ConfigError (a real bug, not a user-fixable state)", () => {
    expect(() =>
      runDoctor({
        nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
        probe: HEALTHY_PROBE,
        loadConfig: () => {
          throw new TypeError("boom");
        },
      }),
    ).toThrow(TypeError);
  });
});

describe("runDoctor — required CLIs", () => {
  it("fails when claude is missing", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: probeFrom({ git: { ok: true, output: "git version 2.43.0" } }),
      loadConfig: () => A_CONFIG,
    });
    const claude = find(report, "Claude CLI");
    expect(claude.status).toBe("fail");
    expect(claude.detail).toContain("not found on PATH");
    expect(report.ok).toBe(false);
  });

  it("fails when git is missing", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: probeFrom({ claude: { ok: true, output: "1.2.3" } }),
      loadConfig: () => A_CONFIG,
    });
    expect(find(report, "git").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("reports the first line of a multi-line version string", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: HEALTHY_PROBE,
      loadConfig: () => A_CONFIG,
    });
    expect(find(report, "GitHub CLI (gh)").detail).toBe("gh version 2.40.0 (2024-01-01)");
  });
});

describe("runDoctor — gh is optional", () => {
  /** A probe where claude+git are healthy and gh is configurable per-arg. */
  function ghProbe(version: boolean, auth: boolean): CommandProbe {
    return (command, args) => {
      if (command === "claude") return { ok: true, output: "1.2.3" };
      if (command === "git") return { ok: true, output: "git version 2.43.0" };
      if (command === "gh") {
        if (args[0] === "auth") return { ok: auth, output: auth ? "Logged in" : "not logged in" };
        return { ok: version, output: version ? "gh version 2.40.0" : "not found" };
      }
      return { ok: false, output: "not found" };
    };
  }

  it("warns (never fails the run) when gh is absent", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: ghProbe(false, false),
      loadConfig: () => A_CONFIG,
    });
    const gh = find(report, "GitHub CLI (gh)");
    expect(gh.status).toBe("warn");
    expect(gh.detail).toContain("not found on PATH");
    // Optional → the overall run is still ok.
    expect(report.ok).toBe(true);
  });

  it("warns with an auth hint when gh is present but unauthenticated", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: ghProbe(true, false),
      loadConfig: () => A_CONFIG,
    });
    const gh = find(report, "GitHub CLI (gh)");
    expect(gh.status).toBe("warn");
    expect(gh.detail).toContain("gh auth login");
    expect(report.ok).toBe(true);
  });

  it("is ok when gh is present and authenticated", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: ghProbe(true, true),
      loadConfig: () => A_CONFIG,
    });
    expect(find(report, "GitHub CLI (gh)").status).toBe("ok");
  });
});

describe("formatReport", () => {
  it("renders a symbol per check and an all-passed footer", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: HEALTHY_PROBE,
      loadConfig: () => A_CONFIG,
    });
    const text = formatReport(report);
    expect(text).toContain("✓ Node.js:");
    expect(text).toContain("✓ Claude CLI:");
    expect(text).toContain("All required checks passed.");
  });

  it("renders ✗ and the failure footer when a required check fails", () => {
    const report = runDoctor({
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probe: probeFrom({ git: { ok: true, output: "git version 2.43.0" } }),
      loadConfig: () => A_CONFIG,
    });
    const text = formatReport(report);
    expect(text).toContain("✗ Claude CLI:");
    expect(text).toContain("Some required checks failed");
  });
});

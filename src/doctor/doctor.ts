import { execFileSync } from "node:child_process";
import { ConfigError, loadConfig, type Config } from "../config.js";
import { errorMessage } from "../errorMessage.js";

/**
 * `overseer doctor`: a one-shot preflight that checks the prerequisites Overseer
 * shells out to (the `claude` / `git` / `gh` CLIs) and its own config, and prints
 * a green/red checklist — converting the README's reactive Troubleshooting table
 * into a proactive check a first-time user runs *before* failing into each gap.
 *
 * The logic is a pure {@link runDoctor} over injectable seams (a command probe and
 * `loadConfig`), so the whole report is testable without touching the real PATH,
 * environment, or filesystem; the CLI wires it to {@link realProbe} and prints
 * {@link formatReport}.
 */

/** The minimum Node major Overseer supports (mirrors `engines.node` in package.json). */
export const MIN_NODE_MAJOR = 22;

/** How a single check came out. `ok`/`warn`/`fail` map to ✓/⚠/✗ in the printout. */
export type CheckStatus = "ok" | "warn" | "fail";

/**
 * Whether a check gates readiness. A failed `required` check fails the whole run
 * (non-zero exit); an `optional` check can only ever `warn` — its absence disables
 * a feature (the PR keybinds) but never blocks the board.
 */
export type CheckLevel = "required" | "optional";

/** The outcome of one prerequisite check. */
export interface CheckResult {
  /** Human-facing label, e.g. `"Claude CLI"`. */
  readonly name: string;
  readonly level: CheckLevel;
  readonly status: CheckStatus;
  /** One-line detail: the resolved version, the actionable fix, or the config root. */
  readonly detail: string;
}

/** The full preflight report. */
export interface DoctorReport {
  readonly checks: readonly CheckResult[];
  /** `false` iff any `required` check `fail`ed — the CLI exit code keys off this. */
  readonly ok: boolean;
}

/** The result of probing one command: did it exit zero, and its captured output. */
export interface ProbeResult {
  /** `true` iff the command launched and exited zero. */
  readonly ok: boolean;
  /** Captured stdout on success, or the error message on failure. */
  readonly output: string;
}

/**
 * Run a command and report whether it succeeded — the one I/O seam doctor needs.
 * The default {@link realProbe} shells out; tests inject a map of canned results.
 */
export type CommandProbe = (
  command: string,
  args: readonly string[],
) => ProbeResult;

/** The seams {@link runDoctor} consumes; the CLI binds them to the real environment. */
export interface DoctorDeps {
  /** The running Node version string, e.g. `process.version` (`"v22.3.0"`). */
  readonly nodeVersion: string;
  /** Probes the external CLIs (`claude` / `git` / `gh`). */
  readonly probe: CommandProbe;
  /** Loads + validates the config; the default is {@link loadConfig}. */
  readonly loadConfig: () => Config;
}

/**
 * Run every preflight check and roll the results into a {@link DoctorReport}.
 *
 * Order is fixed-but-incidental (environment → config → the shelled-out CLIs).
 * `ok` is `true` unless some `required` check `fail`ed; an `optional` check
 * (`gh`) never moves `ok`, it only ever surfaces a `warn`.
 */
export function runDoctor(deps: DoctorDeps): DoctorReport {
  const checks: CheckResult[] = [
    checkNode(deps.nodeVersion),
    checkConfig(deps.loadConfig),
    checkRequiredTool(
      deps.probe,
      "claude",
      ["--version"],
      "Claude CLI",
      "dispatch (`d`/`r`) and the Reactor can't spawn agents without it. Install it, then run `claude` once to authenticate.",
    ),
    checkRequiredTool(
      deps.probe,
      "git",
      ["--version"],
      "git",
      "needed for the per-PRD feature branches and per-Issue worktrees agents build in.",
    ),
    checkGh(deps.probe),
  ];

  const ok = checks.every(
    (c) => !(c.level === "required" && c.status === "fail"),
  );
  return { checks, ok };
}

/** Node ≥ {@link MIN_NODE_MAJOR}; a version we can't parse is a soft warn, not a hard fail. */
function checkNode(version: string): CheckResult {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (Number.isNaN(major)) {
    return {
      name: "Node.js",
      level: "required",
      status: "warn",
      detail: `could not parse version "${version}" (need ≥ ${MIN_NODE_MAJOR})`,
    };
  }
  if (major >= MIN_NODE_MAJOR) {
    return {
      name: "Node.js",
      level: "required",
      status: "ok",
      detail: `${version} (≥ ${MIN_NODE_MAJOR} required)`,
    };
  }
  return {
    name: "Node.js",
    level: "required",
    status: "fail",
    detail: `${version} is too old — Overseer needs Node ≥ ${MIN_NODE_MAJOR}.`,
  };
}

/**
 * Config presence + validity, reusing the board's own {@link loadConfig} so the
 * check can never drift from what launch actually requires. A {@link ConfigError}
 * (missing file, missing/invalid `root`, root that doesn't exist) becomes a `fail`
 * carrying that error's already-actionable message verbatim; any other throw is a
 * real bug and propagates.
 */
function checkConfig(load: () => Config): CheckResult {
  try {
    const config = load();
    return {
      name: "Configuration",
      level: "required",
      status: "ok",
      detail: `root = ${config.root}`,
    };
  } catch (err) {
    if (err instanceof ConfigError) {
      return {
        name: "Configuration",
        level: "required",
        status: "fail",
        detail: `${err.message} (run \`overseer init\` to bootstrap one)`,
      };
    }
    throw err;
  }
}

/**
 * A required external CLI: `ok` with its first version line when the probe exits
 * zero, else `fail` with why it matters and how to fix it. `why` completes the
 * sentence "`<command>` not found on PATH (or failed to run) — …".
 */
function checkRequiredTool(
  probe: CommandProbe,
  command: string,
  args: readonly string[],
  label: string,
  why: string,
): CheckResult {
  const result = probe(command, args);
  if (result.ok) {
    return {
      name: label,
      level: "required",
      status: "ok",
      detail: firstLine(result.output),
    };
  }
  return {
    name: label,
    level: "required",
    status: "fail",
    detail: `\`${command}\` not found on PATH (or failed to run) — ${why}`,
  };
}

/**
 * `gh` is optional — it powers only the PR keybinds (`P` / `g`) and the Linked-PR
 * marker; everything else works without it — so it can only ever `warn`. Two
 * distinct gaps get two distinct messages: not installed, vs installed but
 * unauthenticated (`gh auth status` exits non-zero), since the fix differs.
 */
function checkGh(probe: CommandProbe): CheckResult {
  const version = probe("gh", ["--version"]);
  if (!version.ok) {
    return {
      name: "GitHub CLI (gh)",
      level: "optional",
      status: "warn",
      detail:
        "not found on PATH — the PR features (`P` / `g`) are unavailable; everything else works.",
    };
  }
  const auth = probe("gh", ["auth", "status"]);
  if (!auth.ok) {
    return {
      name: "GitHub CLI (gh)",
      level: "optional",
      status: "warn",
      detail:
        "installed but not authenticated — run `gh auth login` to enable the PR features (`P` / `g`).",
    };
  }
  return {
    name: "GitHub CLI (gh)",
    level: "optional",
    status: "ok",
    detail: firstLine(version.output),
  };
}

/** Collapse multi-line version output (e.g. `gh --version`) to its first line. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

const SYMBOL: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

/**
 * Render a {@link DoctorReport} as the plain text the CLI prints: one
 * `<symbol> <name>: <detail>` line per check, then a summary footer. Pure (no
 * color, no I/O) so the output is asserted directly in tests.
 */
export function formatReport(report: DoctorReport): string {
  const lines = report.checks.map(
    (c) => `${SYMBOL[c.status]} ${c.name}: ${c.detail}`,
  );
  lines.push("");
  lines.push(
    report.ok
      ? "All required checks passed."
      : "Some required checks failed — fix the ✗ items above, then re-run `overseer doctor`.",
  );
  return lines.join("\n") + "\n";
}

/** Cap on captured probe output; version strings are tiny, this just bounds a runaway. */
const PROBE_MAX_BUFFER = 1024 * 1024;
/** Probes run on a deliberate, infrequent command, but a hung CLI must not wedge it. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The production probe: shell out, capturing stdout and exit status. A non-zero
 * exit, a missing binary, a timeout, or an overflow all throw `execFileSync`,
 * which we narrow to `{ ok: false }` carrying the message — exactly the signal the
 * checks branch on (binary present? authenticated?). stderr is captured rather
 * than inherited so a tool's diagnostics don't bleed onto the clean checklist.
 */
export const realProbe: CommandProbe = (command, args) => {
  try {
    const output = execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
    });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: errorMessage(err) };
  }
};

import { describe, it, expect, vi } from "vitest";
import {
  parseLiveSet,
  computeLiveness,
  createLivenessProbe,
  type LivenessSeam,
} from "./liveness.js";

/**
 * The liveness module is the highest-value surface of the feature: it joins the
 * handles Overseer recorded at spawn time against Claude's live session registry
 * (`claude agents --json`) and returns a per-Issue trust-qualified absence (ADR
 * 0008 / 0009). Both halves are pure data-in/data-out, fed fixture JSON — no test
 * launches a real Claude process, mirroring how the dispatcher is tested behind
 * its exec seam.
 *
 * The load-bearing, easily-mis-simplified logic is the **degraded-vs-clean**
 * distinction (ADR 0009): a *thrown* or *non-array* query must yield
 * `absent-degraded` (→ `unknown` on the card, never `orphaned`), while a
 * cleanly-parsed array — even an empty one — yields `absent-clean`, the only path
 * to `orphaned`. These cases are pinned hard below.
 */
describe("parseLiveSet row parsing", () => {
  // The membership-set half of the parse, asserted via `.agents`. (The trust
  // signal — `degraded` — is pinned in its own block below.) `parseLiveSet` is
  // the single parse entry point; there is no trust-blind `parseAgents` wrapper
  // to keep in sync, so this is the only place the row shapes are exercised.
  it("reads a background row's `state` field", () => {
    const json = JSON.stringify([
      { id: "sess-bg", cwd: "/repo", state: "busy" },
    ]);

    expect(parseLiveSet(json).agents).toEqual([{ id: "sess-bg", state: "busy" }]);
  });

  it("reads an interactive row's `status` field", () => {
    const json = JSON.stringify([
      { id: "sess-int", cwd: "/repo", status: "idle" },
    ]);

    // The two row shapes (interactive `status` vs background `state`) are
    // normalised to the same `state` so downstream code never branches on shape.
    expect(parseLiveSet(json).agents).toEqual([{ id: "sess-int", state: "idle" }]);
  });

  it("parses a mix of both shapes in one array", () => {
    const json = JSON.stringify([
      { id: "bg", state: "blocked" },
      { id: "int", status: "busy" },
    ]);

    expect(parseLiveSet(json).agents).toEqual([
      { id: "bg", state: "blocked" },
      { id: "int", state: "busy" },
    ]);
  });

  it("drops a row with no usable id", () => {
    const json = JSON.stringify([
      { cwd: "/repo", state: "busy" },
      { id: "", state: "idle" },
      { id: "keep", state: "busy" },
    ]);

    expect(parseLiveSet(json).agents).toEqual([{ id: "keep", state: "busy" }]);
  });

  it("keeps a row whose state field is absent (state captured as undefined)", () => {
    const json = JSON.stringify([{ id: "stateless" }]);

    // The id is what the join needs; the state is captured for a future "is it
    // hung?" iteration, so its absence must not drop the row from the live set.
    expect(parseLiveSet(json).agents).toEqual([
      { id: "stateless", state: undefined },
    ]);
  });

  it("prefers a meaningful status over an empty-string state", () => {
    // A `??` would let `state: ""` win over a real `status`; the row carries the
    // first non-empty string instead.
    const json = JSON.stringify([{ id: "sess", state: "", status: "busy" }]);

    expect(parseLiveSet(json).agents).toEqual([{ id: "sess", state: "busy" }]);
  });

  it("captures state as undefined when both fields are empty strings", () => {
    const json = JSON.stringify([{ id: "sess", state: "", status: "" }]);

    expect(parseLiveSet(json).agents).toEqual([{ id: "sess", state: undefined }]);
  });
});

describe("parseLiveSet", () => {
  // The trust signal (ADR 0009) — `degraded` decides whether an absent handle may
  // ever become `orphaned`. Only a value that parses to an array is trustworthy.
  it("flags a cleanly-parsed array as trustworthy, even when empty", () => {
    expect(parseLiveSet("[]")).toEqual({ agents: [], degraded: false });
    expect(
      parseLiveSet(JSON.stringify([{ id: "sess-a", state: "busy" }])),
    ).toEqual({ agents: [{ id: "sess-a", state: "busy" }], degraded: false });
  });

  it("flags unparseable JSON as degraded with an empty live set", () => {
    expect(parseLiveSet("not json")).toEqual({ agents: [], degraded: true });
    expect(parseLiveSet("")).toEqual({ agents: [], degraded: true });
  });

  it("flags a non-array value (an error object) as degraded", () => {
    // The registry printed something that wasn't the expected array — an error
    // object, truncated output. Claude can't be trusted to have reported the true
    // live set, so no absent handle may be called gone.
    expect(parseLiveSet("{}")).toEqual({ agents: [], degraded: true });
    expect(parseLiveSet('{"error":"boom"}')).toEqual({
      agents: [],
      degraded: true,
    });
  });
});

describe("computeLiveness", () => {
  it("marks an Issue whose recorded handle is in the live set live", () => {
    const verdicts = computeLiveness(
      { "prd/001.md": "sess-a" },
      [{ id: "sess-a", state: "busy" }],
      false,
    );

    expect(verdicts).toEqual({ "prd/001.md": "live" });
  });

  it("marks an absent handle absent-clean after a trustworthy query", () => {
    // The handle is gone and the query parsed cleanly: a genuine absence, which
    // the scanner may turn into `orphaned` on an active lane (ADR 0009).
    const verdicts = computeLiveness(
      { "prd/001.md": "sess-dead" },
      [{ id: "sess-other", state: "busy" }],
      false,
    );

    expect(verdicts).toEqual({ "prd/001.md": "absent-clean" });
  });

  it("marks an absent handle absent-degraded when the query was untrustworthy", () => {
    // Same membership miss, but the query couldn't be trusted — so the absence is
    // degraded, and can only ever read as `unknown`, never `orphaned`.
    const verdicts = computeLiveness(
      { "prd/001.md": "sess-dead" },
      [],
      true,
    );

    expect(verdicts).toEqual({ "prd/001.md": "absent-degraded" });
  });

  it("classifies each recorded Issue independently against one trust verdict", () => {
    const verdicts = computeLiveness(
      { "prd/001.md": "live-handle", "prd/002.md": "dead-handle" },
      [{ id: "live-handle", state: "idle" }],
      false,
    );

    expect(verdicts).toEqual({
      "prd/001.md": "live",
      "prd/002.md": "absent-clean",
    });
  });

  it("returns no verdicts when nothing was ever recorded", () => {
    expect(computeLiveness({}, [{ id: "sess-a", state: "busy" }], false)).toEqual(
      {},
    );
  });

  it("gives no verdict for an Issue with no recorded handle, only for recorded ones", () => {
    // The missing-sidecar-entry case: a wave recorded one Issue's handle but not
    // its sibling's (the sibling's spawn crashed in the spawn/record gap, or it
    // was dispatched by a previous session). Only the recorded Issue gets a
    // verdict; the missing one is absent from the map, and the scanner overlay
    // reads that absence as unknown.
    const verdicts = computeLiveness(
      { "prd/001.md": "recorded-but-dead" },
      [{ id: "unrelated-live-agent", state: "busy" }],
      false,
    );

    expect(verdicts).toEqual({ "prd/001.md": "absent-clean" });
    expect(verdicts["prd/002.md"]).toBeUndefined();
  });
});

describe("createLivenessProbe", () => {
  it("queries the registry, joins the recorded handles, and returns verdicts", () => {
    const query: LivenessSeam = vi.fn(() =>
      JSON.stringify([{ id: "live-handle", state: "busy" }]),
    );
    const probe = createLivenessProbe({
      query,
      readHandles: () => ({
        "prd/001.md": "live-handle",
        "prd/002.md": "dead-handle",
      }),
    });

    expect(probe()).toEqual({
      "prd/001.md": "live",
      "prd/002.md": "absent-clean",
    });
    expect(query).toHaveBeenCalledOnce();
  });

  // ── The degraded-vs-clean distinction (ADR 0009) ────────────────────────────
  // The single most important — and most reversible-by-accident — behaviour: a
  // false `orphaned` invites a double-spawn, so any untrustworthy query degrades
  // every absent handle to `absent-degraded` (→ `unknown`), never `orphaned`.

  it("degrades every absent handle when the registry query throws", () => {
    // `claude agents --json` failing to run (binary missing, non-zero exit,
    // timeout) must not crash the board open, and must never read as `orphaned`:
    // the agent might still be alive behind the failure (ADR 0009).
    const probe = createLivenessProbe({
      query: () => {
        throw new Error("claude: command not found");
      },
      readHandles: () => ({ "prd/001.md": "sess-a" }),
    });

    expect(probe()).toEqual({ "prd/001.md": "absent-degraded" });
  });

  it("degrades every absent handle when the query result is not an array", () => {
    // A registry that printed an error object instead of the array is just as
    // untrustworthy as one that threw — same fail-safe, never `orphaned`.
    const probe = createLivenessProbe({
      query: () => '{"error":"registry unavailable"}',
      readHandles: () => ({ "prd/001.md": "sess-a" }),
    });

    expect(probe()).toEqual({ "prd/001.md": "absent-degraded" });
  });

  it("licenses absent-clean only from a cleanly-parsed array, even an empty one", () => {
    // The empty array is the crux: Claude is up and reports no live agents, so an
    // absent handle is genuinely gone — the only path to `orphaned` downstream.
    const probe = createLivenessProbe({
      query: () => "[]",
      readHandles: () => ({ "prd/001.md": "sess-a" }),
    });

    expect(probe()).toEqual({ "prd/001.md": "absent-clean" });
  });

  it("recomputes on each call — a handle that drops out flips live → absent-clean", () => {
    let live = true;
    const probe = createLivenessProbe({
      query: () =>
        live ? JSON.stringify([{ id: "sess-a", state: "busy" }]) : "[]",
      readHandles: () => ({ "prd/001.md": "sess-a" }),
    });

    expect(probe()).toEqual({ "prd/001.md": "live" });
    live = false;
    // No persistence: the next probe re-queries and re-intersects from scratch,
    // so an agent that exited flips to absent-clean with no stale cache.
    expect(probe()).toEqual({ "prd/001.md": "absent-clean" });
  });

  // ── The honesty boundary ────────────────────────────────────────────────────
  // The previous-session and empty-sidecar cases: every ambiguous join must
  // resolve away from a false `live`. The probe is where the recorded handles
  // meet the live registry, so these are pinned here as well as at the scanner.

  it("yields absent-clean for a prior-session handle absent from a healthy live set", () => {
    // The sidecar still holds a handle a *previous* board session recorded, but
    // that session's agent is gone. The live set even has an unrelated agent
    // running; the join must not be fooled into a false live.
    const probe = createLivenessProbe({
      query: () => JSON.stringify([{ id: "this-session-agent", state: "busy" }]),
      readHandles: () => ({ "prd/001.md": "prior-session-handle" }),
    });

    expect(probe()).toEqual({ "prd/001.md": "absent-clean" });
  });

  it("yields no verdict from an empty sidecar, so nothing can read live", () => {
    // A fresh board open with an empty sidecar: there are live agents, but none
    // was recorded by *this* session, so the join produces no verdict at all —
    // the scanner overlay defaults those active-agent cards to unknown.
    const probe = createLivenessProbe({
      query: () => JSON.stringify([{ id: "some-live-agent", state: "busy" }]),
      readHandles: () => ({}),
    });

    expect(probe()).toEqual({});
  });

  it("never confuses a previous session's live agent for this session's Issue", () => {
    // Two Issues recorded across two sessions: one handle is still live, the
    // other (an older session's) is not. Only the present match reads live; the
    // previous-session handle reads absent-clean — proving membership is
    // per-handle, never a blanket "an agent is alive somewhere".
    const probe = createLivenessProbe({
      query: () => JSON.stringify([{ id: "live-now", state: "idle" }]),
      readHandles: () => ({
        "prd/001.md": "live-now",
        "prd/002.md": "from-a-closed-session",
      }),
    });

    expect(probe()).toEqual({
      "prd/001.md": "live",
      "prd/002.md": "absent-clean",
    });
  });
});

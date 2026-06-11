import { describe, it, expect, vi } from "vitest";
import {
  parseAgents,
  computeLiveness,
  createLivenessProbe,
  type LivenessSeam,
} from "./liveness.js";

/**
 * The liveness module is the highest-value surface of the feature: it joins the
 * handles Overseer recorded at spawn time against Claude's live session registry
 * (`claude agents --json`) and returns a per-Issue live/unknown verdict (ADR
 * 0008). Both halves are pure data-in/data-out, fed fixture JSON — no test
 * launches a real Claude process, mirroring how the dispatcher is tested behind
 * its exec seam.
 */
describe("parseAgents", () => {
  it("reads a background row's `state` field", () => {
    const json = JSON.stringify([
      { id: "sess-bg", cwd: "/repo", state: "busy" },
    ]);

    expect(parseAgents(json)).toEqual([{ id: "sess-bg", state: "busy" }]);
  });

  it("reads an interactive row's `status` field", () => {
    const json = JSON.stringify([
      { id: "sess-int", cwd: "/repo", status: "idle" },
    ]);

    // The two row shapes (interactive `status` vs background `state`) are
    // normalised to the same `state` so downstream code never branches on shape.
    expect(parseAgents(json)).toEqual([{ id: "sess-int", state: "idle" }]);
  });

  it("parses a mix of both shapes in one array", () => {
    const json = JSON.stringify([
      { id: "bg", state: "blocked" },
      { id: "int", status: "busy" },
    ]);

    expect(parseAgents(json)).toEqual([
      { id: "bg", state: "blocked" },
      { id: "int", state: "busy" },
    ]);
  });

  it("reads an empty array as no live agents", () => {
    expect(parseAgents("[]")).toEqual([]);
  });

  it("reads malformed or non-array JSON as no live agents", () => {
    // A registry that printed something unexpected (an error object, truncated
    // output, garbage) degrades every Issue to unknown rather than crashing the
    // board open — the same fail-safe the sidecar uses for a corrupt file.
    expect(parseAgents("not json")).toEqual([]);
    expect(parseAgents("{}")).toEqual([]);
    expect(parseAgents("")).toEqual([]);
  });

  it("drops a row with no usable id", () => {
    const json = JSON.stringify([
      { cwd: "/repo", state: "busy" },
      { id: "", state: "idle" },
      { id: "keep", state: "busy" },
    ]);

    expect(parseAgents(json)).toEqual([{ id: "keep", state: "busy" }]);
  });

  it("keeps a row whose state field is absent (state captured as undefined)", () => {
    const json = JSON.stringify([{ id: "stateless" }]);

    // The id is what the join needs; the state is captured for a future "is it
    // hung?" iteration, so its absence must not drop the row from the live set.
    expect(parseAgents(json)).toEqual([{ id: "stateless", state: undefined }]);
  });
});

describe("computeLiveness", () => {
  it("marks an Issue whose recorded handle is in the live set live", () => {
    const verdicts = computeLiveness(
      { "prd/001.md": "sess-a" },
      [{ id: "sess-a", state: "busy" }],
    );

    expect(verdicts).toEqual({ "prd/001.md": "live" });
  });

  it("marks an Issue whose recorded handle is absent unknown", () => {
    const verdicts = computeLiveness(
      { "prd/001.md": "sess-dead" },
      [{ id: "sess-other", state: "busy" }],
    );

    expect(verdicts).toEqual({ "prd/001.md": "unknown" });
  });

  it("marks every Issue unknown when no agents are live", () => {
    const verdicts = computeLiveness(
      { "prd/001.md": "sess-a", "prd/002.md": "sess-b" },
      [],
    );

    expect(verdicts).toEqual({
      "prd/001.md": "unknown",
      "prd/002.md": "unknown",
    });
  });

  it("verdicts each recorded Issue independently", () => {
    const verdicts = computeLiveness(
      { "prd/001.md": "live-handle", "prd/002.md": "dead-handle" },
      [{ id: "live-handle", state: "idle" }],
    );

    expect(verdicts).toEqual({
      "prd/001.md": "live",
      "prd/002.md": "unknown",
    });
  });

  it("returns no verdicts when nothing was ever recorded", () => {
    expect(computeLiveness({}, [{ id: "sess-a", state: "busy" }])).toEqual({});
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
      "prd/002.md": "unknown",
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("degrades every Issue to unknown when the registry query throws", () => {
    // `claude agents --json` failing to run (binary missing, non-zero exit) must
    // not crash the board open: liveness simply reads as unknown everywhere,
    // never a false live (ADR 0008).
    const probe = createLivenessProbe({
      query: () => {
        throw new Error("claude: command not found");
      },
      readHandles: () => ({ "prd/001.md": "sess-a" }),
    });

    expect(probe()).toEqual({ "prd/001.md": "unknown" });
  });

  it("recomputes on each call — a handle that drops out flips live → unknown", () => {
    let live = true;
    const probe = createLivenessProbe({
      query: () =>
        live ? JSON.stringify([{ id: "sess-a", state: "busy" }]) : "[]",
      readHandles: () => ({ "prd/001.md": "sess-a" }),
    });

    expect(probe()).toEqual({ "prd/001.md": "live" });
    live = false;
    // No persistence: the next probe re-queries and re-intersects from scratch,
    // so an agent that exited flips to unknown with no stale cache (ADR 0008).
    expect(probe()).toEqual({ "prd/001.md": "unknown" });
  });
});

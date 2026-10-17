import { describe, expect, it } from "vitest";
import type { RunEvent, RunView } from "@pineagent/core/contracts";
import { applyRunEvent, DONE_HOLD_MS, ERROR_HOLD_MS, mergeRuns, plantFace } from "../../src/runs/runs";

const ME = "dev|me";
const NOW = 1_000_000;
let n = 0;

function run(patch: Partial<RunView> = {}): RunView {
  n++;
  return {
    runId: `r${n}`, ownerId: ME, ownerName: "me", task: "t", state: "executing", routerMode: "jev", nodeIndex: 0,
    seq: 1, steps: [], writeSet: [], startedAt: NOW - 10_000 + n, ...patch,
  };
}
const event = (r: RunView): RunEvent => ({
  runId: r.runId, ownerId: r.ownerId, workspaceId: "w", seq: r.seq, state: r.state, routerMode: r.routerMode, nodeIndex: r.nodeIndex, ts: NOW, run: r,
});
const face = (runs: RunView[], opts: Partial<Parameters<typeof plantFace>[2]> = {}) =>
  plantFace(runs, ME, { connection: "connected", now: NOW, ...opts }).face;

describe("run events", () => {
  it("drops events at or below the last seq seen, accepts newer ones", () => {
    const r = run({ seq: 5 });
    const runs = new Map([[r.runId, r]]);
    expect(applyRunEvent(runs, event({ ...r, seq: 5, state: "done" }))).toBeNull();
    expect(applyRunEvent(runs, event({ ...r, seq: 4, state: "done" }))).toBeNull();
    expect(applyRunEvent(runs, event({ ...r, seq: 6, state: "done" }))?.get(r.runId)?.state).toBe("done");
  });

  it("a run:list after reconnect never replaces a newer snapshot", () => {
    const r = run({ seq: 9, state: "done" });
    const merged = mergeRuns(new Map([[r.runId, r]]), [{ ...r, seq: 7, state: "executing" }, run({ runId: "new", seq: 1 })]);
    expect(merged.get(r.runId)?.state).toBe("done");
    expect(merged.has("new")).toBe(true);
  });
});

describe("what the plant shows", () => {
  it("idle with no runs; the run's state otherwise", () => {
    expect(face([])).toBe("idle");
    expect(face([run({ state: "planning" })])).toBe("planning");
  });

  it("follows the LLD priority: error > approval > blocked > executing > routing > planning > done", () => {
    const order = ["error", "awaiting_approval", "blocked", "executing", "routing", "planning", "done"] as const;
    for (let i = 0; i < order.length; i++) {
      const runs = order.slice(i).map((state) => run({ state, endedAt: NOW - 100 }));
      expect(face(runs)).toBe(order[i]);
    }
  });

  it("shows only the signed-in user's runs", () => {
    expect(face([run({ ownerId: "dev|bob", state: "error", endedAt: NOW })])).toBe("idle");
  });

  it("routing shows the router mode: cache and LLM fallback have their own faces", () => {
    expect(face([run({ state: "routing", routerMode: "jev" })])).toBe("routing");
    expect(face([run({ state: "routing", routerMode: "cache" })])).toBe("routing_cache");
    expect(face([run({ state: "routing", routerMode: "llm" })])).toBe("routing_llm");
  });

  it("done smiles briefly, errors linger longer, then back to idle", () => {
    expect(face([run({ state: "done", endedAt: NOW - 100 })])).toBe("done");
    expect(face([run({ state: "done", endedAt: NOW - DONE_HOLD_MS - 1 })])).toBe("idle");
    expect(face([run({ state: "error", endedAt: NOW - DONE_HOLD_MS - 1 })])).toBe("error");
    expect(face([run({ state: "error", endedAt: NOW - ERROR_HOLD_MS - 1 })])).toBe("idle");
  });

  it("connection trouble wins over everything", () => {
    expect(face([run({ state: "error" })], { connection: "reconnecting" })).toBe("reconnecting");
    expect(face([], { connection: "offline" })).toBe("disconnected");
  });

  it("a teammate joining plays briefly, but never over an error or an approval question", () => {
    const team = { kind: "team_join" as const, at: NOW - 500 };
    expect(face([run({ state: "executing" })], { team })).toBe("team_join");
    expect(face([run({ state: "awaiting_approval" })], { team })).toBe("awaiting_approval");
    expect(face([run({ state: "executing" })], { team: { ...team, at: NOW - 10_000 } })).toBe("executing");
  });
});

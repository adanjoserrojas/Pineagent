# Socket.IO Contract Draft: Agent Runs (browser view)

**Status:** Draft from Software Engineer 2 describing what the run panel and the plant picker need. The run-state machine, harness and router are Software Engineer 1's (LLD sections 1, 2 and the backend of 9); SE1 owns this contract after the freeze. Implemented only by the mock harness (`apps/web/mock/harness.ts`).

## Run event

The minimum fields fixed in `PROJECT_MEMORY.md`, plus a full `run` snapshot (PROPOSED) so a browser that reconnects or misses an event never has to rebuild a run from deltas.

```ts
type RunState = "planning" | "routing" | "awaiting_approval" | "blocked" | "executing" | "paused" | "error" | "done";
type RouterMode = "openai" | "jev" | "cache" | "llm";
type CodingRecovery = "none" | "warm_agent";

type RunEvent = {
  runId: string;
  ownerId: string;
  workspaceId: string;
  seq: number;              // monotonic per run; consumers drop seq <= last seen
  state: RunState;
  routerMode: RouterMode | null;   // null until routing has picked a mode
  codingRecovery?: CodingRecovery; // PROPOSED: optional for the existing mock; real backend emits it
  nodeIndex: number;        // current step, -1 before executing
  ts: number;
  run: RunView;             // PROPOSED: full snapshot after this event
};

type RunStep = { tool: string; detail: string; writes: string[] };
type RunCandidate = { id: string; score: number; steps: RunStep[] };

type RunView = {
  runId: string; ownerId: string; ownerName: string; task: string;
  state: RunState; routerMode: RouterMode | null; codingRecovery?: CodingRecovery;
  nodeIndex: number; seq: number;
  steps: RunStep[];                 // the chosen DAG in execution order; [] until routed
  candidates?: RunCandidate[];      // only while awaiting_approval (top 3)
  confidence?: number;              // top candidate's score
  writeSet: string[];
  blockedOn?: { path: string; holder: string };
  error?: { nodeIndex: number; message: string };
  startedAt: number; endedAt?: number;
};
```

### Routing versus coding recovery

OpenAI Decisions is the primary Master-1 scorer (`routerMode: "openai"`, matching the current harness adapter). Jev is an **availability backup** when Decisions cannot score, including rate limits or exhausted quota (`routerMode: "jev"`). `cache` means a previously scored route was reused; `llm` means scoring is unavailable or the approval path switches to the step-by-step LLM router. Low confidence by itself pauses for approval; it does not imply a Jev failover.

`codingRecovery` is independent of `routerMode`. It starts as `none` and becomes `warm_agent` only if the selected DAG fails visible verification and a coding agent continues from its existing working tree and evidence. A run can therefore have both `routerMode: "jev"` and `codingRecovery: "warm_agent"`. Do not report coding recovery as `routerMode: "llm"`, and do not report a Jev scorer failover as coding recovery. The backend increments `seq` and emits a new `run:event` when either value changes; the top-level value and `run` snapshot must agree. This field remains optional in the draft TypeScript mirror so SWE 2's current mock stays compatible; the real backend should always include it before interface freeze.

## Events

| Event | Direction | Payload | Ack |
| --- | --- | --- | --- |
| `run:start` | C→S | `{ task }` | `{ ok: true, runId }` or `{ ok: false, code: "BAD_REQUEST" }` |
| `run:list` | C→S | `{}` | `{ ok: true, runs: RunView[] }`. Used on every (re)join. |
| `run:approve` | C→S | `{ runId, candidateId }` or `{ runId, none: true, hint }` | `{ ok: true }` or `{ ok: false, code: "NOT_OWNER" \| "NOT_WAITING" }`. Never by voice (LLD 11). |
| `run:pause` / `run:resume` | C→S | `{ runId }` | same codes. Pause takes effect at the next step boundary. |
| `run:event` | S→room | `RunEvent` | Every member reads every run (LLD 11); only the owner may act. |

## Browser rules

1. Keep one `RunView` per run; replace it only when `seq` is greater than the stored one.
2. The plant shows the signed-in user's highest-priority run: `error > awaiting_approval > blocked > executing > routing > planning > done > idle`. `paused` shows as the firmware's `paused` face; `done` shows for a few seconds, then `idle`.
3. On reconnect (socket or plant), fetch `run:list` and re-send the current plant state.
4. `routerMode: "openai"` displays Decisions; `jev` identifies scorer-provider failover; `cache` identifies route reuse; `llm` identifies step-by-step routing fallback. A warm coding-recovery indicator, if shown, uses `codingRecovery` instead of `routerMode`.

## Firmware face names

`STATE <name>` accepts the keys in `firmware/PlantBotTestKit/animations/viewport/states.json`. Run states map to `planning`, `routing` (`routing_cache` / `routing_llm` by router mode), `executing`, `awaiting_approval`, `blocked`, `paused`, `error`, `done`, `idle`; connection loss maps to `reconnecting` / `disconnected`. The Web Serial bridge is the Hardware Engineer's.

## Open items for Software Engineer 1

- Real candidate DAGs, scores and step names come from the selector and router.
- Whether `run:event` carries the full snapshot or a separate `run:get` is preferred.
- Blocked runs: which lock holder to report when several paths are held.

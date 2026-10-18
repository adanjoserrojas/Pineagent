import { DEV_TOOLS } from "../devtools";
import { useId, useState, type FormEvent } from "react";
import type { Member, RouterMode, RunActionAck, RunState, RunView } from "../contracts/socket";
import type { WorkspaceSocket } from "../net/socket";
import { PlantConnect } from "../plant/PlantConnect";
import { faceInfo, VirtualPlant } from "../plant/VirtualPlant";
import { Avatar } from "../ui/Avatar";
import { faceFor, type PlantView } from "./runs";

const ACK_TIMEOUT_MS = 5000;
const MAX_SHOWN = 12;

const STATE_LABEL: Record<RunState, string> = {
  planning: "planning",
  routing: "routing",
  awaiting_approval: "needs a choice",
  blocked: "waiting for a lock",
  executing: "executing",
  paused: "paused",
  error: "failed",
  done: "done",
};
// contracts/RUN_EVENTS.md rule 4: Decisions is the normal case; Jev means the scorer failed over.
const ROUTER_LABEL: Record<RouterMode, string> = {
  openai: "router: OpenAI Decisions",
  jev: "router: Jev (backup scorer)",
  cache: "router: cache",
  llm: "router: LLM fallback",
};
const PAUSABLE = new Set<RunState>(["planning", "routing", "blocked", "executing"]);

type Props = {
  socket: WorkspaceSocket;
  runs: Map<string, RunView>;
  selfId: string | null;
  members: Member[];
  branch: string;
  plant: PlantView;
  connected: boolean;
};

// Start agent runs, follow everyone's runs on the branch (read-only unless they're yours), answer
// approval questions, and see what the plant is showing (LLD 9 and 11).
export function RunPanel({ socket, runs, selfId, members, branch, plant, connected }: Props) {
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const all = [...runs.values()];
  const mine = all.filter((r) => r.ownerId === selfId).sort((a, b) => b.startedAt - a.startedAt);
  const others = all.filter((r) => r.ownerId !== selfId).sort((a, b) => b.startedAt - a.startedAt);
  const shown = [...mine, ...others].slice(0, MAX_SHOWN);

  const nameOf = (id: string) => (id === selfId ? "you" : (members.find((m) => m.userId === id)?.name ?? id.replace(/^.*\|/, "")));

  async function start(e: FormEvent) {
    e.preventDefault();
    if (!connected || starting || !task.trim()) return;
    setStarting(true);
    setProblem(null);
    try {
      const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("run:start", { task });
      if (res.ok) setTask("");
      else setProblem(res.code === "NOT_AVAILABLE" ? "Agent runs aren’t available on this server yet." : "The server didn’t accept that task.");
    } catch {
      setProblem("The server didn’t answer. Try again.");
    } finally {
      setStarting(false);
    }
  }

  const plantCaption =
    plant.reason === "connection"
      ? "Reconnecting to the workspace"
      : plant.reason === "team"
        ? "A teammate came or went"
        : plant.run
          ? `Your run ${shortId(plant.run.runId)} · ${STATE_LABEL[plant.run.state]}`
          : "No active run";

  return (
    <aside className="runs" aria-label="Agent runs">
      <div className="agent-heading"><h2 className="section-label">Agents</h2><span title={branch}>on {branch}</span></div>

      <VirtualPlant face={plant.face} caption={plantCaption} />
      <PlantConnect />
      <div className="run-feed">
        {shown.length === 0 ? (
          <p className="run-empty">No runs yet. Give your agent a focused task to get growing.</p>
        ) : (
          <ul className="run-list" aria-label="Runs">
            {shown.map((r) => (
              <li key={r.runId}>
                <RunCard run={r} mine={r.ownerId === selfId} socket={socket} members={members} nameOf={nameOf} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <form className="run-form" onSubmit={start}>
        <label htmlFor="run-task">Ask your agent</label>
        <textarea
          id="run-task"
          rows={3}
          value={task}
          placeholder="e.g. Add a test for currentUser"
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(e);
          }}
        />
        {DEV_TOOLS && (
          <p className="run-hint">
            Mock agent: include <code>unsure</code>, <code>backup</code>, <code>fallback</code>, <code>recover</code> or <code>fail</code>, or a file name like <code>db.ts</code>.
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={!connected || starting || !task.trim()}>
          {starting ? "Starting…" : "Start run"}
        </button>
        {problem && (
          <p className="run-problem" role="alert">
            {problem}
          </p>
        )}
      </form>
    </aside>
  );
}

function RunCard({
  run,
  mine,
  socket,
  members,
  nameOf,
}: {
  run: RunView;
  mine: boolean;
  socket: WorkspaceSocket;
  members: Member[];
  nameOf: (id: string) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const detailsId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const owner = members.find((m) => m.userId === run.ownerId);
  const chip = faceInfo(faceFor(run));

  async function act(send: () => Promise<RunActionAck>) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await send();
      if (!res.ok) setProblem(res.code === "NOT_WAITING" ? "The run already moved on." : "That isn’t possible right now.");
    } catch {
      setProblem("The server didn’t answer. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const call = (event: "run:pause" | "run:resume") =>
    act(() =>
      event === "run:pause"
        ? socket.timeout(ACK_TIMEOUT_MS).emitWithAck("run:pause", { runId: run.runId })
        : socket.timeout(ACK_TIMEOUT_MS).emitWithAck("run:resume", { runId: run.runId }),
    );

  return (
    <article className="run-card" data-run={run.runId} data-state={run.state} aria-label={`${mine ? "Your" : `${run.ownerName}’s`} run ${shortId(run.runId)}`}>
      <header className="run-head">
        <Avatar name={run.ownerName} url={owner?.avatarUrl ?? null} size={22} />
        <span className="run-owner">{mine ? "Your agent" : `${run.ownerName}’s agent`}</span>
        <span className="spacer" />
        <span className="run-chip" style={{ background: chip.background }} data-testid="run-state">
          {STATE_LABEL[run.state]}
        </span>
        <button type="button" className="run-disclosure" aria-label={`${collapsed ? "Expand" : "Collapse"} run ${shortId(run.runId)}`}
          aria-expanded={!collapsed} aria-controls={detailsId} onClick={() => setCollapsed((value) => !value)}>{collapsed ? "›" : "⌄"}</button>
      </header>

      <p className="run-task">{run.task}</p>
      <div className="run-details" id={detailsId} hidden={collapsed}>
      <div className="run-badges">
        <span className="run-id mono">run {shortId(run.runId)}</span>
        {run.routerMode && (
          <span className={`run-badge${run.routerMode === "llm" || run.routerMode === "jev" ? " run-badge-warn" : ""}`} data-testid="router-mode">
            {ROUTER_LABEL[run.routerMode]}
          </span>
        )}
        {/* Independent of routing: a coding agent took over after a step failed verification. */}
        {run.codingRecovery === "warm_agent" && (
          <span className="run-badge run-badge-warn" data-testid="coding-recovery">
            coding recovery: warm agent
          </span>
        )}
        {run.writeSet.map((p) => (
          <span key={p} className="run-badge mono">
            writes {p}
          </span>
        ))}
      </div>

      {run.state === "blocked" && run.blockedOn && (
        <p className="run-note">
          Waiting for {nameOf(run.blockedOn.holder)} to finish editing <span className="mono">{run.blockedOn.path}</span>.
        </p>
      )}

      {run.state === "awaiting_approval" && run.candidates && (
        mine ? (
          <Approval run={run} busy={busy} onChoose={(choice) => act(() => socket.timeout(ACK_TIMEOUT_MS).emitWithAck("run:approve", { runId: run.runId, ...choice }))} />
        ) : (
          <p className="run-note">Waiting for {run.ownerName} to choose a plan.</p>
        )
      )}

      {run.steps.length > 0 && (
        <ol className="run-steps" aria-label="Steps">
          {run.steps.map((s, i) => {
            const mark = stepMark(run, i);
            return (
              <li key={i} className={`run-step run-step-${mark}`}>
                <span className="run-step-mark">
                  <span aria-hidden="true">{mark === "done" ? "✓" : mark === "failed" ? "!" : i + 1}</span>
                  <span className="sr-only">{mark}</span>
                </span>
                <span className="mono">
                  {s.tool} <span className="run-step-detail">{s.detail}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {run.state === "error" && run.error && (
        <p className="run-error" role="alert">
          {run.error.phase ? `Failed during ${run.error.phase}` : run.error.nodeIndex < 0 ? "Failed before execution" : `Failed at step ${run.error.nodeIndex + 1}`}: {run.error.message}
        </p>
      )}

      {mine && (PAUSABLE.has(run.state) || run.state === "paused") && (
        <div className="run-actions">
          {run.state === "paused" ? (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => call("run:resume")}>
              Resume
            </button>
          ) : (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => call("run:pause")}>
              Pause
            </button>
          )}
          {run.state === "paused" && <span className="run-note">Paused at a step boundary. File ownership is shown in the editor.</span>}
        </div>
      )}
      {problem && (
        <p className="run-problem" role="alert">
          {problem}
        </p>
      )}
      </div>
    </article>
  );
}

// LLD 2: low confidence never auto-writes. The owner picks one of the top plans or asks for a replan.
function Approval({
  run,
  busy,
  onChoose,
}: {
  run: RunView;
  busy: boolean;
  onChoose: (choice: { candidateId: string } | { none: true; hint: string }) => void;
}) {
  const [picked, setPicked] = useState<string>(run.candidates![0].id);
  const [hint, setHint] = useState("");
  const none = picked === "none";
  return (
    <fieldset className="run-approval">
      <legend>The agent isn’t sure. Pick a plan:</legend>
      {run.candidates!.map((c) => (
        <label key={c.id} className="run-option">
          <input type="radio" name={`plan-${run.runId}`} value={c.id} checked={picked === c.id} onChange={() => setPicked(c.id)} />
          <span className="run-option-score">{Math.round(c.score * 100)}%</span>
          <span className="mono run-option-steps">{c.steps.map((s) => s.tool).join(" → ")}</span>
        </label>
      ))}
      <label className="run-option">
        <input type="radio" name={`plan-${run.runId}`} value="none" checked={none} onChange={() => setPicked("none")} />
        <span>None of these</span>
      </label>
      {none && (
        <label className="run-hint-input">
          What should it do instead?
          <input type="text" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. keep the public API the same" />
        </label>
      )}
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={() => onChoose(none ? { none: true, hint } : { candidateId: picked })}
      >
        {none ? "Replan with this hint" : "Run this plan"}
      </button>
    </fieldset>
  );
}

function stepMark(run: RunView, i: number): "done" | "now" | "next" | "failed" {
  if (run.state === "done") return "done";
  if (run.state === "error" && run.error?.nodeIndex === i) return "failed";
  if (i < run.nodeIndex) return "done";
  if (i === run.nodeIndex && (run.state === "executing" || run.state === "paused")) return "now";
  return "next";
}

const shortId = (runId: string) => runId.replace(/^run-/, "");

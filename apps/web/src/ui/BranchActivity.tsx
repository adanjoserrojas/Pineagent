import type { WorkspaceState } from "../state/workspace";
import { WorkspaceIcon } from "./WorkspaceIcon";

/** A current-state summary, not a fabricated event history or terminal. */
export function BranchActivity({ ws }: { ws: WorkspaceState }) {
  const locks = [...ws.locks.values()];
  const activeRuns = [...ws.runs.values()].filter((run) => run.state !== "done" && run.state !== "error").length;
  return (
    <section className="branch-activity" aria-label="Branch activity">
      <header><h2 className="section-label">Branch activity</h2><span>{ws.connection === "connected" ? "LIVE SNAPSHOT" : "LAST KNOWN STATE"}</span></header>
      <div className="activity-summary">{activeRuns} active runs <span>·</span> {ws.gitQueue.length} queued Git jobs</div>
      {locks.length === 0 ? <p className="activity-empty">No active locks. Ownership appears here as people and agents edit.</p> : (
        <ul>{locks.slice(0, 3).map((lock) => (
          <li key={lock.path} className={lock.holderType === "run" ? "activity-agent" : lock.holder === ws.self?.userId ? "activity-you" : "activity-other"}>
            <WorkspaceIcon name="lock" /><code>{lock.path}</code>
            <span>{lock.holder === ws.self?.userId ? "You" : ws.members.find((m) => m.userId === lock.holder)?.name ?? "Teammate"}{lock.holderType === "run" ? " · agent" : ""}</span>
          </li>
        ))}</ul>
      )}
      {locks.length > 3 && <p className="activity-empty">+{locks.length - 3} more locks in Explorer</p>}
    </section>
  );
}

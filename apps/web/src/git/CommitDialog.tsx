import { useEffect, useRef, useState } from "react";
import type { GitChange, GitJob, GitResult, GitStatusAck, Member } from "../contracts/socket";
import type { SessionManager } from "../editor/sessions";
import type { WorkspaceSocket } from "../net/socket";
import { Avatar } from "../ui/Avatar";

const ACK_TIMEOUT_MS = 8000;

type Props = {
  open: boolean;
  onClose: () => void;
  socket: WorkspaceSocket;
  manager: SessionManager | null;
  selfId: string | null;
  members: Member[];
  queue: GitJob[];
  lastResult: GitResult | null;
};

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; status: GitStatusAck };

// Commit only your own changes (release scenario 7). The server decides what is yours and checks
// again when the job runs; this dialog shows its answer and the job's progress through the queue.
export function CommitDialog({ open, onClose, socket, manager, selfId, members, queue, lastResult }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<GitResult | null>(null);
  const known = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Load on open and after every Git result in the branch (anyone's commit changes the picture).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck("git:status", {})
      .then(
        (status: GitStatusAck) => {
          if (cancelled) return;
          setLoad({ state: "ready", status });
          // Keep the user's unticks; newly committable files start ticked. React runs the updater
          // later, so capture the previous list now rather than reading the ref inside it.
          const committable = status.changes.filter((c) => c.committable).map((c) => c.path);
          const seenBefore = known.current;
          known.current = new Set(committable);
          setSelected((prev) => new Set(committable.filter((p) => prev.has(p) || !seenBefore.has(p))));
        },
        () => !cancelled && setLoad({ state: "error" }),
      );
    return () => {
      cancelled = true;
    };
  }, [open, socket, lastResult]);

  useEffect(() => {
    if (!jobId || lastResult?.jobId !== jobId) return;
    setOutcome(lastResult);
    setJobId(null);
    if (lastResult.ok) setMessage("");
  }, [lastResult, jobId]);

  const nameOf = (userId: string) =>
    userId === selfId ? "you" : (members.find((m) => m.userId === userId)?.name ?? userId.replace(/^.*\|/, ""));
  const memberOf = (userId: string) => members.find((m) => m.userId === userId);

  const status = load.state === "ready" ? load.status : null;
  const mine = status?.changes.filter((c) => c.committable) ?? [];
  const others = status?.changes.filter((c) => !c.committable) ?? [];
  const chosen = mine.filter((c) => selected.has(c.path)).map((c) => c.path);
  const myJob = jobId ? queue.find((j) => j.id === jobId) : undefined;
  const ahead = myJob ? queue.findIndex((j) => j.id === jobId) : queue.length;
  const busy = submitting || jobId !== null;
  const canCommit = chosen.length > 0 && message.trim().length > 0 && !busy;
  const canPushOnly = chosen.length === 0 && (status?.ahead ?? 0) > 0 && !busy;

  async function submit(push: boolean) {
    setProblem(null);
    setOutcome(null);
    setSubmitting(true);
    try {
      // Make sure the last keystrokes reached the server before asking it to commit.
      if (chosen.length && manager && !(await manager.whenSaved(chosen))) {
        setProblem("Some of your edits are still saving. Try again in a moment.");
        return;
      }
      const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("git:commit", { paths: chosen, message, push });
      if (res.ok) setJobId(res.jobId);
      else setProblem("The server didn’t accept that request.");
    } catch {
      setProblem("The server didn’t answer. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog ref={ref} className="commit-dialog" aria-labelledby="commit-title" onClose={onClose}>
      <header className="commit-head">
        <h2 id="commit-title">
          Commit to <span className="mono">{status?.branch ?? "…"}</span>
        </h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div className="commit-body">
        {load.state === "loading" && <p className="commit-note">Checking what changed…</p>}
        {load.state === "error" && (
          <p className="commit-note" role="alert">
            Couldn’t load your changes. Close and try again.
          </p>
        )}

        {status && (
          <>
            <fieldset className="commit-group">
              <legend>
                Your changes · {mine.length} {mine.length === 1 ? "file" : "files"}
              </legend>
              {mine.length === 0 && <p className="commit-note">You have no uncommitted changes of your own.</p>}
              {mine.map((c) => (
                <label key={c.path} className="commit-row commit-row-mine">
                  <input
                    type="checkbox"
                    checked={selected.has(c.path)}
                    disabled={busy}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(c.path);
                      else next.delete(c.path);
                      setSelected(next);
                    }}
                  />
                  <span className="mono commit-path">{c.path}</span>
                  <Counts change={c} />
                </label>
              ))}
            </fieldset>

            {others.length > 0 && (
              <div className="commit-group">
                <h3>Not included · other people’s work</h3>
                <ul className="commit-list">
                  {others.map((c) => {
                    const owner = c.editors.find((e) => e !== selfId) ?? c.editors[0];
                    const m = owner ? memberOf(owner) : undefined;
                    return (
                      <li key={c.path} className="commit-row commit-row-other" data-path={c.path}>
                        <LockIcon />
                        <span className="mono commit-path">{c.path}</span>
                        {owner && <Avatar name={m?.name ?? nameOf(owner)} url={m?.avatarUrl ?? null} size={18} />}
                        <span className="commit-reason">{reasonText(c, nameOf, selfId)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <label className="commit-message">
              Commit message
              <textarea
                rows={3}
                value={message}
                disabled={busy}
                placeholder="What did you change?"
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>

            <p className="commit-queue" role="status" aria-live="polite">
              <span className={`queue-dot${queue.length ? " queue-busy" : ""}`} aria-hidden="true" />
              {queueText(queue, myJob, ahead, nameOf)}
            </p>

            {problem && (
              <p className="commit-problem" role="alert">
                {problem}
              </p>
            )}
            {outcome && <Outcome result={outcome} />}
          </>
        )}
      </div>

      <footer className="commit-foot">
        <span className="commit-hint">Push runs commit → pull --rebase → push as one job. If the rebase conflicts, nothing is pushed.</span>
        {canPushOnly ? (
          <button type="button" className="btn-primary commit-btn" onClick={() => submit(true)}>
            Push {status!.ahead} {status!.ahead === 1 ? "commit" : "commits"}
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" disabled={!canCommit} onClick={() => submit(false)}>
              Commit {chosen.length} {chosen.length === 1 ? "file" : "files"}
            </button>
            <button type="button" className="btn-primary commit-btn" disabled={!canCommit} onClick={() => submit(true)}>
              Commit and push
            </button>
          </>
        )}
      </footer>
    </dialog>
  );
}

function Counts({ change }: { change: GitChange }) {
  return (
    <span className="mono commit-counts" aria-label={`${change.added} lines added, ${change.removed} removed`}>
      <span className="plus">+{change.added}</span> <span className="minus">−{change.removed}</span>
    </span>
  );
}

function reasonText(c: GitChange, nameOf: (id: string) => string, selfId: string | null): string {
  const names = c.editors.map(nameOf);
  switch (c.reason) {
    case "OTHERS_EDITED":
      return c.editors.includes(selfId ?? "") ? `Shared · edited by ${names.join(" and ")}` : `${names.join(" and ")}’s work`;
    case "LOCKED_BY_OTHER":
      return "Someone else is editing it now";
    case "UNATTRIBUTED":
      return "Changed outside the editor";
    default:
      return "";
  }
}

function queueText(queue: GitJob[], mine: GitJob | undefined, ahead: number, nameOf: (id: string) => string): string {
  const label = (j: GitJob) => `${nameOf(j.userId)} · ${j.kind.replace("commit+push", "commit and push")}`;
  if (mine) {
    if (mine.state === "running") return mine.kind === "commit" ? "Committing…" : "Committing and pushing…";
    return `Queued · ${ahead} ${ahead === 1 ? "job" : "jobs"} ahead of you (${queue.slice(0, ahead).map(label).join(", ")})`;
  }
  if (queue.length === 0) return "Git queue is free.";
  return `Git queue: ${queue.map(label).join(", ")}. Yours will start after ${queue.length === 1 ? "it" : "them"}.`;
}

function Outcome({ result }: { result: GitResult }) {
  if (result.ok) {
    const sha = result.sha?.slice(0, 7);
    return (
      <p className="commit-success" role="status">
        {result.paths.length ? `Committed ${sha}` : "Pushed"}
        {result.pushed ? " and pushed to the remote." : "."}
      </p>
    );
  }
  return (
    <div className="commit-problem" role="alert">
      <p>{result.message}</p>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

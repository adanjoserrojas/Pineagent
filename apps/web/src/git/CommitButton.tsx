import { useEffect, useState } from "react";
import type { GitJob, GitResult, GitStatusAck } from "../contracts/socket";
import type { WorkspaceSocket } from "../net/socket";
import { commitButtonView } from "../ui/profile";

const ACK_TIMEOUT_MS = 8000;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = isMac ? "⌘⇧K" : "Ctrl+Shift+K";

// Top-bar entry to the commit dialog: shows how many files this person can commit right now.
export function CommitButton({
  socket,
  connected,
  selfId,
  changes,
  queue,
  lastResult,
  onClick,
}: {
  socket: WorkspaceSocket | null;
  connected: boolean;
  selfId: string | null;
  changes: unknown;
  queue: GitJob[];
  lastResult: GitResult | null;
  onClick: () => void;
}) {
  const [ready, setReady] = useState(0);
  const [ahead, setAhead] = useState(0);
  const busy = selfId !== null && queue.some((j) => j.userId === selfId);

  // Committable depends on who edited what, so ask the server instead of deriving it from `changes`.
  useEffect(() => {
    if (!socket || !connected) return;
    let live = true;
    const timer = setTimeout(() => {
      socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck("git:status", {})
        .then((res: GitStatusAck) => {
          if (!live || !res.ok) return;
          setReady(res.changes.filter((c) => c.committable).length);
          setAhead(res.ahead);
        })
        .catch(() => {});
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [socket, connected, changes, lastResult]);

  useEffect(() => {
    if (!connected) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation(); // Monaco binds Ctrl+Shift+K to "delete line"
        onClick();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [connected, onClick]);

  const view = commitButtonView(ready, ahead, busy);
  const title = connected ? `Commit your changes (${SHORTCUT})` : "Commit is unavailable until you are connected";
  return (
    <button
      type="button"
      className={`commit-top ${view.primary ? "commit-top-primary" : ""}`}
      disabled={!connected}
      title={title}
      aria-label={view.aria}
      aria-keyshortcuts="Control+Shift+K Meta+Shift+K"
      onClick={onClick}
    >
      {view.busy ? <span className="spinner" aria-hidden="true" /> : <CommitIcon />}
      <span aria-hidden="true">{view.label}</span>
      {view.badge !== null && (
        <span className="commit-badge" aria-hidden="true">
          {view.badge}
        </span>
      )}
    </button>
  );
}

function CommitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M1 8h4.5M10.5 8H15" />
    </svg>
  );
}

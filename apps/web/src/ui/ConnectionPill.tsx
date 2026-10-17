import type { ConnectionStatus } from "../state/workspace";

const LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  offline: "Offline · edits paused",
  unauthenticated: "Signed out · sign in again",
  forbidden: "No access to this repository",
};

export function ConnectionPill({ status }: { status: ConnectionStatus }) {
  return (
    <span className={`pill pill-${status}`} role="status" aria-live="polite" data-testid="connection">
      <span className="pill-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}

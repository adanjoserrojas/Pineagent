import type { ConnectionStatus } from "../state/workspace";

const LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  offline: "Offline · edits paused",
  unauthenticated: "Signed out · sign in again",
  forbidden: "No access to this repository",
};

// When the server turns the token down, the pill is the way back in.
export function ConnectionPill({ status, onSignIn }: { status: ConnectionStatus; onSignIn?: () => void }) {
  if (status === "unauthenticated" && onSignIn) {
    return (
      <span role="status" aria-live="polite">
        <button type="button" className={`pill pill-${status} pill-action`} data-testid="connection" onClick={onSignIn}>
          <span className="pill-dot" aria-hidden="true" />
          {LABELS[status]}
        </button>
      </span>
    );
  }
  return (
    <span className={`pill pill-${status}`} role="status" aria-live="polite" data-testid="connection">
      <span className="pill-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}

import Editor from "@monaco-editor/react";
import { useEffect, useState } from "react";
import type { SnapshotAck } from "../contracts/socket";
import type { WorkspaceSocket } from "../net/socket";
import "./monacoSetup";

const SNAPSHOT_TIMEOUT_MS = 5000;

// Tagged with the path it belongs to, so a stale snapshot never renders under another file's name.
type View = { path: string } & (
  | { status: "loading" }
  | { status: "ready"; content: string; version: number }
  | { status: "missing" }
  | { status: "error" }
);

// Read-only view of one file from `file:snapshot`. Editing (lock + ops) arrives with FileSession in M4.
export default function EditorPane({
  socket,
  path,
  connected,
}: {
  socket: WorkspaceSocket;
  path: string;
  connected: boolean;
}) {
  const [loaded, setView] = useState<View>({ path, status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const view: View = loaded.path === path ? loaded : { path, status: "loading" };

  useEffect(() => {
    // While disconnected keep showing the last snapshot; refetch once the room is rejoined.
    if (!connected) return;
    let cancelled = false;
    setView((v) => (v.status === "ready" && v.path === path ? v : { path, status: "loading" }));
    socket
      .timeout(SNAPSHOT_TIMEOUT_MS)
      .emitWithAck("file:snapshot", { path })
      .then(
        (res: SnapshotAck) => {
          if (cancelled) return;
          setView(
            res.ok ? { path, status: "ready", content: res.content, version: res.version } : { path, status: "missing" },
          );
        },
        () => !cancelled && setView({ path, status: "error" }),
      );
    return () => {
      cancelled = true;
    };
  }, [socket, path, connected, attempt]);

  return (
    <section className="editor" aria-label={`Editor: ${path}`}>
      <div className="editor-tabs" role="tablist">
        <span role="tab" aria-selected="true" className="editor-tab mono">
          {path}
        </span>
      </div>
      <div className="editor-body">
        {view.status === "ready" ? (
          <Editor
            path={path}
            value={view.content}
            theme="pineagent"
            loading={<p className="editor-note">Starting editor…</p>}
            options={{
              readOnly: true,
              readOnlyMessage: { value: "Editing arrives with file locks." },
              fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
              fontSize: 13,
              lineHeight: 22,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderLineHighlight: "all",
              padding: { top: 12 },
              automaticLayout: true,
            }}
          />
        ) : view.status === "loading" ? (
          <p className="editor-note" aria-busy="true">
            Loading {path}…
          </p>
        ) : view.status === "missing" ? (
          <p className="editor-note" role="alert">
            {path} isn’t on the server anymore.
          </p>
        ) : (
          <div className="editor-note" role="alert">
            <p>The server didn’t send {path} in time.</p>
            <button type="button" className="btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
      </div>
      <footer className="editor-status">
        <span>{connected ? "● Read-only · editing arrives with file locks" : "Offline · showing last loaded version"}</span>
        <span className="spacer" />
        {view.status === "ready" && <span className="mono">v{view.version}</span>}
      </footer>
    </section>
  );
}

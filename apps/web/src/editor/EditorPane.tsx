import Editor from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import type { SnapshotAck } from "../contracts/socket";
import type { WorkspaceSocket } from "../net/socket";
import "./monacoSetup";

const SNAPSHOT_TIMEOUT_MS = 5000;
// Loads faster than this never show an indicator, so switching files doesn't flash.
const SLOW_LOAD_MS = 250;

type Snapshot = { path: string; content: string; version: number };
type Failure = { path: string; kind: "missing" | "error" };

// Read-only view of files from `file:snapshot`. Editing (lock + ops) arrives with FileSession in M4.
//
// The Monaco instance stays mounted across file switches: it keeps showing the last loaded file until
// the next snapshot arrives, then swaps. Snapshots are cached per path and revalidated on every open.
export default function EditorPane({
  socket,
  path,
  connected,
}: {
  socket: WorkspaceSocket;
  path: string;
  connected: boolean;
}) {
  const cache = useRef(new Map<string, Snapshot>());
  const [shown, setShown] = useState<Snapshot | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const pending = shown?.path !== path;
  const failed = failure?.path === path ? failure : null;

  useEffect(() => {
    const cached = cache.current.get(path);
    if (cached) setShown(cached);
    // While disconnected keep showing what we have; revalidate once the room is rejoined.
    if (!connected) return;
    let cancelled = false;
    setFailure(null);
    socket
      .timeout(SNAPSHOT_TIMEOUT_MS)
      .emitWithAck("file:snapshot", { path })
      .then(
        (res: SnapshotAck) => {
          if (cancelled) return;
          if (!res.ok) {
            cache.current.delete(path);
            setFailure({ path, kind: "missing" });
            return;
          }
          const snap = { path, content: res.content, version: res.version };
          cache.current.set(path, snap);
          setShown(snap);
        },
        () => !cancelled && setFailure({ path, kind: "error" }),
      );
    return () => {
      cancelled = true;
    };
  }, [socket, path, connected, attempt]);

  // Show the loading state only when a load is actually slow.
  useEffect(() => {
    setSlow(false);
    if (!pending || failed) return;
    const t = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(t);
  }, [pending, failed, path]);

  return (
    <section className="editor" aria-label={`Editor: ${path}`} aria-busy={pending && !failed}>
      <div className="editor-tabs" role="tablist">
        <span role="tab" aria-selected="true" className="editor-tab mono">
          {path}
        </span>
      </div>
      <div className="editor-body">
        {failed ? (
          <div className="editor-note" role="alert">
            {failed.kind === "missing" ? (
              <p>{path} isn’t on the server anymore.</p>
            ) : (
              <>
                <p>The server didn’t send {path} in time.</p>
                <button type="button" className="btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
                  Retry
                </button>
              </>
            )}
          </div>
        ) : shown ? (
          <>
            {/* Keyed by the shown snapshot's path, never the requested one, so Monaco can't cache
                one file's text under another file's model. */}
            <Editor
              path={shown.path}
              value={shown.content}
              theme="pineagent"
              loading={null}
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
            {pending && slow && (
              <div className="editor-loading" role="status">
                Loading {path}…
              </div>
            )}
          </>
        ) : (
          slow && (
            <p className="editor-note" role="status">
              Loading {path}…
            </p>
          )
        )}
      </div>
      <footer className="editor-status">
        <span>{connected ? "● Read-only · editing arrives with file locks" : "Offline · showing last loaded version"}</span>
        <span className="spacer" />
        {!pending && shown && <span className="mono">v{shown.version}</span>}
      </footer>
    </section>
  );
}

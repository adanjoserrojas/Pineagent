import { DEV_TOOLS } from "../devtools";
import { WorkspaceIcon } from "../ui/WorkspaceIcon";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Lock, Member, Op } from "../contracts/socket";
import type { SessionState } from "./FileSession";
import type { SessionManager } from "./sessions";
import "./monacoSetup";

// Loads faster than this never show an indicator, so switching files doesn't flash.
const SLOW_LOAD_MS = 250;
const HELD_NOTICE_MS = 6000;
const EDITABLE = new Set<SessionState["status"]>(["viewing", "acquiring", "writing"]);

// Binds the SessionManager's FileSessions to one Monaco instance. Monaco stays mounted across file
// switches and keeps showing the previous file until the next one has text (cached or fresh).
export default function EditorPane({
  manager,
  path,
  connected,
  selfId,
  members,
  onPauseRun,
}: {
  manager: SessionManager;
  path: string;
  connected: boolean;
  selfId: string | null;
  members: Member[];
  onPauseRun?: (runId: string) => void;
}) {
  const requested = manager.get(path);
  const requestedState = useSyncExternalStore(requested.subscribe, requested.getState);
  const hasText = (s: SessionState) => s.version > 0 || s.status === "missing" || s.status === "unsupported" || s.status === "error";

  const [shownPath, setShownPath] = useState(path);
  useEffect(() => {
    if (hasText(requestedState)) setShownPath(path);
  }, [requestedState, path]);
  const shown = manager.get(shownPath);
  const state = useSyncExternalStore(shown.subscribe, shown.getState);
  const switching = shownPath !== path;

  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!switching && hasText(state)) return;
    const t = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(t);
  }, [switching, state, path]);

  // --- Monaco binding -----------------------------------------------------------------------
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const applyingRemote = useRef(false); // changes we make for the server must not echo back as typing
  const shownRef = useRef(shown);
  const [mountId, setMountId] = useState(0);

  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // e2e reads the exact buffer through this; Monaco's DOM only renders visible lines.
    if (DEV_TOOLS) (window as unknown as { __editorText?: () => string }).__editorText = () => editor.getValue();
    editor.onDidChangeModelContent((e) => {
      if (applyingRemote.current || e.isFlush) return;
      // All offsets in one event refer to the text before the event. Applying from the end of the
      // document backwards keeps earlier offsets valid, which is what "apply in array order" needs.
      const ops: Op[] = [...e.changes]
        .sort((a, b) => b.rangeOffset - a.rangeOffset)
        .map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }));
      shownRef.current.localEdit(ops);
    });
    setMountId((n) => n + 1);
  };

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const withModel = (fn: (m: Monaco.editor.ITextModel) => void) => {
      const model = editor.getModel();
      if (!model) return;
      applyingRemote.current = true;
      try {
        fn(model);
      } finally {
        applyingRemote.current = false;
      }
    };
    const replace = (text: string) => withModel((m) => m.getValue() !== text && m.setValue(text));
    replace(shown.getState().text);
    shown.bind({
      replace,
      apply: (ops) =>
        withModel((m) => {
          for (const op of ops) {
            const s = m.getPositionAt(op.offset);
            const e = m.getPositionAt(op.offset + op.length);
            m.applyEdits([{ range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), text: op.text }]);
          }
        }),
    });
    return () => shown.bind(null);
  }, [shown, mountId]);

  // --- D1 notice ----------------------------------------------------------------------------
  useEffect(() => {
    if (!state.heldNotice) return;
    const t = setTimeout(() => shown.clearHeldNotice(), HELD_NOTICE_MS);
    return () => clearTimeout(t);
  }, [state.heldNotice, shown]);

  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [state.lostText]);

  const nameOf = (lock: Lock) => {
    const member = members.find((m) => m.userId === lock.holder);
    const name = member?.name ?? lock.holder.replace(/^.*\|/, "");
    if (lock.holderType === "run") return lock.holder === selfId ? "Your agent" : `${name}’s agent`;
    return name;
  };

  const readOnly = switching || !EDITABLE.has(state.status);
  const showEditor = hasText(state) && state.status !== "missing" && state.status !== "unsupported" && state.status !== "error";

  return (
    <section className="editor" aria-label={`Editor: ${path}`} aria-busy={switching || state.status === "loading"}>
      <div className="editor-tabs" role="tablist">
        <span role="tab" aria-selected="true" className={`editor-tab mono editor-tab-${switching ? "loading" : state.status}`}>
          {path}
        </span>
      </div>

      {!switching && EDITABLE.has(state.status) && (
        <div className={`ownership-ribbon ownership-${state.status}`} role="status">
          <WorkspaceIcon name="lock" />
          <strong>{state.status === "writing" ? "You’re editing" : state.status === "acquiring" ? "Claiming the file" : "Ready when you are"}</strong>
          <span>{!connected ? "Offline · edits will sync after reconnect." : state.status === "writing" ? "Only you can write to this file." : state.status === "acquiring" ? "Waiting for the server to grant ownership." : "Type to request exclusive editing."}</span>
        </div>
      )}

      {state.lostText !== null && !switching && (
        <section className="lost-banner" role="alert" aria-labelledby="lost-title">
          <div>
            <h2 id="lost-title">Your recent edits to {shownPath} were not saved</h2>
            <p>The file changed on the server or your lock expired while you were away. The editor now shows the saved version.</p>
          </div>
          <div className="lost-actions">
            {/* Clipboard writes need a user gesture, so this has to be a button. */}
            <button
              type="button"
              className="btn-warn"
              onClick={() => navigator.clipboard.writeText(state.lostText ?? "").then(() => setCopied(true))}
            >
              {copied ? "Copied" : "Copy my version"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => shown.dismissLost()}>
              Dismiss
            </button>
          </div>
        </section>
      )}

      {state.status === "readonly" && state.holder && !switching && (
        <div className={`holder-strip ${state.holder.holderType === "run" ? "holder-agent" : ""}`} role="status">
          <WorkspaceIcon name="lock" />
          <strong>{nameOf(state.holder)}</strong>&nbsp;is editing this file. You’re following along live.
          {/* LLD 5: pausing your own agent stops it at the next step and gives the file back. */}
          {state.holder.holderType === "run" && state.holder.holder === selfId && state.holder.runId && onPauseRun && (
            <button type="button" className="link-btn holder-action" onClick={() => onPauseRun(state.holder!.runId!)}>
              Pause agent
            </button>
          )}
        </div>
      )}

      <div className="editor-body">
        {showEditor ? (
          <>
            {/* Keyed by the shown session's path, never the requested one, so Monaco can't cache
                one file's text under another file's model. */}
            <Editor
              path={shownPath}
              defaultValue={state.text}
              theme="pineagent"
              loading={null}
              onMount={onMount}
              options={{
                readOnly,
                readOnlyMessage: {
                  value: state.holder ? `${nameOf(state.holder)} is editing this file.` : "Not editable right now.",
                },
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
            {switching && slow && (
              <div className="editor-loading" role="status">
                Loading {path}…
              </div>
            )}
          </>
        ) : state.status === "unsupported" ? (
          <p className="editor-note" role="status">
            {path} can’t be opened in the editor: {state.unsupported === "binary" ? "it’s a binary file" : "it’s larger than 1 MB"}.
          </p>
        ) : state.status === "missing" ? (
          <p className="editor-note" role="alert">
            {path} isn’t on the server anymore.
          </p>
        ) : state.status === "error" ? (
          <div className="editor-note" role="alert">
            <p>The server didn’t send {path} in time.</p>
            <button type="button" className="btn-secondary" onClick={() => shown.open()}>
              Retry
            </button>
          </div>
        ) : (
          slow && (
            <p className="editor-note" role="status">
              Loading {path}…
            </p>
          )
        )}

        {state.heldNotice && !switching && (
          <div className="held-toast" role="alert">
            <strong>{nameOf(state.heldNotice)} started editing first</strong>
            <span>Your keystroke was undone and the file is read-only for you.</span>
          </div>
        )}
      </div>

      <footer className="editor-status" data-testid="editor-status">
        <span className={`status-${switching ? "loading" : state.status}`}>{statusText(state, switching, connected, nameOf)}</span>
        <span className="spacer" />
        {state.status === "writing" && !switching && (
          <button type="button" className="link-btn" onClick={() => shown.release()}>
            Release lock
          </button>
        )}
        {!switching && state.version > 0 && <span className="mono">v{state.version}</span>}
      </footer>
    </section>
  );
}

function statusText(s: SessionState, switching: boolean, connected: boolean, nameOf: (l: Lock) => string): string {
  if (switching || s.status === "loading") return "Loading…";
  const offline = connected ? "" : " · offline, will sync on reconnect";
  switch (s.status) {
    case "viewing":
      return `● Viewing · type to start editing${offline}`;
    case "acquiring":
      return `○ Requesting the lock…${offline}`;
    case "writing":
      return `● Writing · ${s.inFlight ? "saving…" : "saved"}${offline}`;
    case "readonly":
      return s.holder ? `● Read-only · ${nameOf(s.holder)} is editing` : "● Read-only";
    case "missing":
      return "File not found on the server";
    case "unsupported":
      return "Not editable here";
    case "error":
      return "Couldn’t load this file";
  }
}

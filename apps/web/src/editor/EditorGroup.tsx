import { lazy, Suspense, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { Member } from "../contracts/socket";
import type { WorkspaceSocket } from "../net/socket";
import type { Group } from "./layout";
import { isImagePath } from "./layout";
import type { SessionManager } from "./sessions";

// Monaco is most of the bundle; load it only once a text file is opened.
const EditorPane = lazy(() => import("./EditorPane"));
const ImageViewer = lazy(() => import("./ImageViewer"));

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// One editor group: its tab bar and the active file's editor (or image viewer).
export function EditorGroup({
  group,
  focused,
  canSplit,
  paneId,
  welcome,
  onActivate,
  onClose,
  onSplit,
  manager,
  socket,
  connected,
  selfId,
  members,
  onPauseRun,
}: {
  group: Group;
  focused: boolean;
  canSplit: boolean;
  paneId: string;
  welcome: ReactNode;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onSplit: () => void;
  manager: SessionManager | null;
  socket: WorkspaceSocket | null;
  connected: boolean;
  selfId: string | null;
  members: Member[];
  onPauseRun: (runId: string) => void;
}) {
  return (
    <div className={`editor-group-content${focused ? " editor-group-focused" : ""}`}>
      {group.tabs.length > 0 && <div className="editor-tabbar">
        <div className="editor-tabs" role="tablist" aria-label="Open files">
          {group.tabs.map((path) => (
            <Tab key={path} path={path} active={path === group.active} manager={manager} onActivate={onActivate} onClose={onClose} />
          ))}
        </div>
        {canSplit && (
          <button type="button" className="tab-action" onClick={onSplit} title="Split editor" aria-label="Split editor">
            ◫ Split
          </button>
        )}
      </div>}
      {group.active && manager && socket ? (
        <Suspense fallback={<p className="editor-note">Starting editor…</p>}>
          {isImagePath(group.active) ? (
            <ImageViewer socket={socket} path={group.active} />
          ) : (
            <EditorPane paneId={paneId} showPathHeader={false} manager={manager} path={group.active} connected={connected} selfId={selfId} members={members} onPauseRun={onPauseRun} />
          )}
        </Suspense>
      ) : (
        welcome
      )}
    </div>
  );
}

function Tab({
  path,
  active,
  manager,
  onActivate,
  onClose,
}: {
  path: string;
  active: boolean;
  manager: SessionManager | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  // The lock colour on the tab's edge follows the file's session, like the old single tab did.
  const session = manager && !isImagePath(path) ? manager.get(path) : null;
  const status = useSyncExternalStore(session?.subscribe ?? noSubscribe, () => session?.getState().status ?? "viewing");
  const onAux = (e: MouseEvent) => {
    if (e.button === 1) onClose(path);
  };
  return (
    <div className={`editor-tab${active ? " editor-tab-active" : ""} editor-tab-${status}`} onMouseDown={(e) => e.button === 1 && e.preventDefault()} onAuxClick={onAux}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="tab-label mono"
        title={path}
        aria-label={path}
        onClick={() => onActivate(path)}
      >
        {baseName(path)}
      </button>
      <button type="button" className="tab-close" aria-label={`Close ${path}`} onClick={() => onClose(path)}>
        ×
      </button>
    </div>
  );
}

const noSubscribe = () => () => {};

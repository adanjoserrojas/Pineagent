import { DEV_TOOLS } from "./devtools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "./auth/AuthGate";
import { EditorGroup } from "./editor/EditorGroup";
import { activate, activePaths, close, focus, focusedActive, initialLayout, isImagePath, openIn, split, type Layout } from "./editor/layout";
import { SessionManager } from "./editor/sessions";
import { CommitDialog } from "./git/CommitDialog";
import { RunsColumn } from "./runs/RunsColumn";
import { connectWorkspace, type WorkspaceSocket } from "./net/socket";
import { createWorkspaceStore, useWorkspace } from "./state/workspace";
import { FileTree } from "./tree/FileTree";
import { CommitButton } from "./git/CommitButton";
import { MemberChip } from "./ui/ProfileCard";
import { ConnectionPill } from "./ui/ConnectionPill";
import { RepoPicker } from "./ui/RepoPicker";
import { workspaceFromPath } from "./routes";

const ACK_TIMEOUT_MS = 8000;

function apiUrl() {
  // ?api= lets e2e tests point a page at their own mock instance; dev builds only.
  const override = DEV_TOOLS ? new URLSearchParams(window.location.search).get("api") : null;
  return override ?? import.meta.env.VITE_API_URL ?? "http://localhost:3001";
}

export function App() {
  const target = useMemo(() => workspaceFromPath(window.location.pathname, DEV_TOOLS), []);
  return target ? <WorkspaceApp {...target} /> : <RepoPicker />;
}

function WorkspaceApp({ wsId, branch }: { wsId: string; branch: string }) {
  const session = useSession();
  const store = useMemo(createWorkspaceStore, []);
  const ws = useWorkspace(store);
  const [socket, setSocket] = useState<WorkspaceSocket | null>(null);
  const [layout, setLayout] = useState<Layout>(initialLayout);
  const openPath = focusedActive(layout);
  const openFile = useCallback((path: string) => setLayout((l) => openIn(l, path)), []);
  const [commitOpen, setCommitOpen] = useState(false);

  useEffect(() => {
    const s = connectWorkspace({ apiUrl: apiUrl(), wsId, branch, getToken: session.getToken, store });
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
    };
  }, [wsId, branch, session, store]);

  const [manager, setManager] = useState<SessionManager | null>(null);
  useEffect(() => {
    if (!socket) return;
    const m = new SessionManager(socket, store);
    setManager(m);
    return () => {
      m.dispose();
      setManager(null);
    };
  }, [socket, store]);

  // Each group's active file has a live session; becoming inactive (tab switched or closed)
  // flushes its edits and releases its lock. Images have no session.
  const live = useRef(new Set<string>());
  const activeKey = activePaths(layout).filter((p) => !isImagePath(p)).join("\n");
  useEffect(() => {
    if (!manager) return;
    const want = new Set(activeKey ? activeKey.split("\n") : []);
    for (const p of live.current) if (!want.has(p)) manager.leave(p);
    for (const p of want) if (!live.current.has(p)) manager.open(p);
    live.current = want;
  }, [manager, activeKey]);
  useEffect(
    () => () => {
      if (manager) for (const p of live.current) manager.leave(p);
      live.current = new Set();
    },
    [manager],
  );

  // Presence is re-sent after every (re)join so other people see what this user has open.
  useEffect(() => {
    if (ws.connection === "connected") socket?.emit("presence:update", { openPath });
  }, [socket, openPath, ws.connection]);

  const openCommit = useCallback(() => setCommitOpen(true), []);
  const others = ws.members.filter((m) => m.userId !== ws.self?.userId);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Pineagent</span>
        <span className="mono">{wsId}</span>
        <span className="branch mono">{branch}</span>
        <span className="spacer" />
        <ul className="members" aria-label="People in this branch">
          {ws.self && (
            <li>
              <MemberChip member={{ ...ws.self, openPath }} isSelf locks={ws.locks} onOpenFile={openFile} />
            </li>
          )}
          {others.map((m) => (
            <li key={m.userId}>
              <MemberChip member={m} isSelf={false} locks={ws.locks} onOpenFile={openFile} />
            </li>
          ))}
        </ul>
        <ConnectionPill status={ws.connection} onSignIn={session.signIn} />
        <CommitButton
          socket={socket}
          connected={ws.connection === "connected"}
          selfId={ws.self?.userId ?? null}
          changes={ws.changes}
          queue={ws.gitQueue}
          lastResult={ws.lastGitResult}
          onClick={openCommit}
        />
        <span className="who">{ws.self?.name ?? session.displayName}</span>
      </header>
      {socket && (
        <CommitDialog
          open={commitOpen}
          onClose={() => setCommitOpen(false)}
          socket={socket}
          manager={manager}
          selfId={ws.self?.userId ?? null}
          members={ws.members}
          queue={ws.gitQueue}
          lastResult={ws.lastGitResult}
        />
      )}
      <div className="body">
        <nav className="tree" aria-label="Explorer">
          <FileTree
            key={`${wsId}/${branch}`}
            paths={ws.tree}
            locks={ws.locks}
            changes={ws.changes}
            members={ws.members}
            selfId={ws.self?.userId ?? null}
            openPath={openPath}
            loading={ws.connection !== "connected"}
            onOpen={openFile}
            onCreate={
              socket && ws.connection === "connected"
                ? (path, kind) => socket.timeout(ACK_TIMEOUT_MS).emitWithAck("tree:create", { path, kind }).catch(() => null)
                : undefined
            }
          />
        </nav>
        <main className="workspace-main">
          <div className="editor-groups">
            {layout.groups.map((group, i) => (
              <EditorGroup
                key={i}
                group={group}
                focused={layout.focused === i}
                canSplit={layout.groups.length === 1}
                onFocus={() => setLayout((l) => focus(l, i))}
                onActivate={(p) => setLayout((l) => activate(l, i, p))}
                onClose={(p) => setLayout((l) => close(l, i, p))}
                onSplit={() => setLayout(split)}
                manager={manager}
                socket={socket}
                connected={ws.connection === "connected"}
                selfId={ws.self?.userId ?? null}
                members={ws.members}
                onPauseRun={(runId) => socket?.emit("run:pause", { runId }, () => {})}
              />
            ))}
          </div>
        </main>
        {socket && <RunsColumn ws={ws} socket={socket} branch={branch} />}
      </div>
    </div>
  );
}

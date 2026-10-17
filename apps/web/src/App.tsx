import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "./auth/AuthGate";
import { connectWorkspace, type WorkspaceSocket } from "./net/socket";
import { createWorkspaceStore, useWorkspace } from "./state/workspace";
import { FileTree } from "./tree/FileTree";
import { Avatar } from "./ui/Avatar";
import { ConnectionPill } from "./ui/ConnectionPill";

// URL shape: /ws/<wsId>/<branch>. Anything else opens the mock's demo workspace.
function workspaceFromUrl() {
  const m = window.location.pathname.match(/^\/ws\/([^/]+)\/(.+)$/);
  return m ? { wsId: decodeURIComponent(m[1]), branch: decodeURIComponent(m[2]) } : { wsId: "demo", branch: "main" };
}

function apiUrl() {
  // ?api= lets e2e tests point a page at their own mock instance; dev builds only.
  const override = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("api") : null;
  return override ?? import.meta.env.VITE_API_URL ?? "http://localhost:3001";
}

export function App() {
  const session = useSession();
  const { wsId, branch } = useMemo(workspaceFromUrl, []);
  const store = useMemo(createWorkspaceStore, []);
  const ws = useWorkspace(store);
  const socketRef = useRef<WorkspaceSocket | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);

  useEffect(() => {
    const socket = connectWorkspace({ apiUrl: apiUrl(), wsId, branch, getToken: session.getToken, store });
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [wsId, branch, session, store]);

  // Presence is re-sent after every (re)join so other people see what this user has open.
  useEffect(() => {
    if (ws.connection === "connected") socketRef.current?.emit("presence:update", { openPath });
  }, [openPath, ws.connection]);

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
              <Avatar name={ws.self.name} url={ws.self.avatarUrl} tone="self" label={`You (${ws.self.name})`} />
            </li>
          )}
          {others.map((m) => (
            <li key={m.userId}>
              <Avatar name={m.name} url={m.avatarUrl} tone="other" label={m.openPath ? `${m.name} · viewing ${m.openPath}` : m.name} />
            </li>
          ))}
        </ul>
        <ConnectionPill status={ws.connection} />
        <span className="who">{ws.self?.name ?? session.displayName}</span>
      </header>
      <div className="body">
        <nav className="tree" aria-label="Explorer">
          <FileTree
            paths={ws.tree}
            locks={ws.locks}
            members={ws.members}
            selfId={ws.self?.userId ?? null}
            openPath={openPath}
            loading={ws.connection !== "connected"}
            onOpen={setOpenPath}
          />
        </nav>
        <main className="editor-empty">
          <p>{openPath ? <span className="mono">{openPath}</span> : "Select a file to open it."}</p>
        </main>
      </div>
    </div>
  );
}

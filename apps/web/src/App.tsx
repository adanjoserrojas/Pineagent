import { useEffect, useMemo } from "react";
import { useSession } from "./auth/AuthGate";
import { connectWorkspace } from "./net/socket";
import { createWorkspaceStore, useWorkspace } from "./state/workspace";
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

  useEffect(() => {
    const socket = connectWorkspace({ apiUrl: apiUrl(), wsId, branch, getToken: session.getToken, store });
    return () => {
      socket.close();
    };
  }, [wsId, branch, session, store]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Pineagent</span>
        <span className="mono">{wsId}</span>
        <span className="branch mono">{branch}</span>
        <span className="spacer" />
        <ul className="members" aria-label="People in this branch">
          {ws.members.map((m) => (
            <li key={m.userId} title={m.name} className={m.userId === ws.self?.userId ? "avatar avatar-self" : "avatar"}>
              {m.name.slice(0, 2).toUpperCase()}
            </li>
          ))}
        </ul>
        <ConnectionPill status={ws.connection} />
        <span className="who">{ws.self?.name ?? session.displayName}</span>
      </header>
      <div className="body">
        <nav className="tree" aria-label="Files">
          <h2 className="section-label">Files</h2>
          <ul>
            {ws.tree.map((p) => (
              <li key={p} className="mono">
                {p}
              </li>
            ))}
          </ul>
        </nav>
        <main className="editor-empty">
          <p>Select a file to open it.</p>
        </main>
      </div>
    </div>
  );
}

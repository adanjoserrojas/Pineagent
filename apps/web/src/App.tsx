import { DEV_TOOLS } from "./devtools";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSession } from "./auth/AuthGate";
import { SessionManager } from "./editor/sessions";
import { CommitDialog } from "./git/CommitDialog";
import { RunsColumn } from "./runs/RunsColumn";
import { connectWorkspace, type WorkspaceSocket } from "./net/socket";
import { createWorkspaceStore, useWorkspace } from "./state/workspace";
import { FileTree } from "./tree/FileTree";
import { Avatar } from "./ui/Avatar";
import { ConnectionPill } from "./ui/ConnectionPill";
import { RepoPicker } from "./ui/RepoPicker";
import { workspaceFromPath } from "./routes";
import { CrownMark } from "./ui/CrownMark";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";
import { BranchActivity } from "./ui/BranchActivity";
import { ResizeHandle } from "./ui/ResizeHandle";
import { defaultLayout, useWorkspaceLayout } from "./ui/useWorkspaceLayout";

// Monaco is most of the bundle; load it only once a file is opened.
const EditorPane = lazy(() => import("./editor/EditorPane"));

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
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [panel, setPanel] = useState<"files" | "editor" | "agents">("files");
  const shell = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useWorkspaceLayout();
  const [available, setAvailable] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height }));
    if (shell.current) observer.observe(shell.current);
    return () => observer.disconnect();
  }, []);
  const sideBudget = Math.max(380, available.width - 420);
  const sideTotal = (layout.filesVisible ? layout.explorer : 0) + (layout.agentsVisible ? layout.agents : 0);
  const scale = Math.min(1, sideBudget / Math.max(1, sideTotal));
  const explorerWidth = Math.round(layout.explorer * scale);
  const agentWidth = Math.round(layout.agents * scale);
  const activityHeight = Math.min(layout.activity, Math.max(90, available.height * 0.4));
  function togglePanel(name: "files" | "agents") {
    const key = name === "files" ? "filesVisible" : "agentsVisible";
    if (window.matchMedia("(max-width: 900px)").matches) { showPanel(name); return; }
    setLayout((current) => ({ ...current, [key]: !current[key] }));
    if (!layout[key]) showPanel(name);
    else shell.current?.querySelector<HTMLElement>(".workspace-main")?.focus();
  }
  function showPanel(next: typeof panel) {
    setPanel(next);
    if (next !== "editor") setLayout((current) => ({ ...current, [next === "files" ? "filesVisible" : "agentsVisible"]: true }));
    requestAnimationFrame(() => {
      const selector = next === "files" ? ".explorer-filter input" : next === "agents" ? "#run-task" : ".workspace-main";
      shell.current?.querySelector<HTMLElement>(selector)?.focus();
    });
  }

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

  // Opening a file starts (or resumes) its session; leaving it flushes edits and releases the lock.
  useEffect(() => {
    if (!manager || !openPath) return;
    manager.open(openPath);
    return () => manager.leave(openPath);
  }, [manager, openPath]);

  // Presence is re-sent after every (re)join so other people see what this user has open.
  useEffect(() => {
    if (ws.connection === "connected") socket?.emit("presence:update", { openPath });
  }, [socket, openPath, ws.connection]);

  const others = ws.members.filter((m) => m.userId !== ws.self?.userId);

  return (
    <div className="app crown" ref={shell} data-panel={panel}
      data-files={layout.filesVisible} data-agents={layout.agentsVisible}
      style={{ "--explorer-width": `${explorerWidth}px`, "--agent-width": `${agentWidth}px`, "--activity-height": `${activityHeight}px` } as CSSProperties}>
      <header className="topbar">
        <span className="brand"><CrownMark />pineagent<span className="brand-edition">CROWN</span></span>
        <span className="workspace-name mono" title={wsId}>{wsId}</span>
        <span className="branch mono" title={branch}><WorkspaceIcon name="branch" />{branch}</span>
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
        <ConnectionPill status={ws.connection} onSignIn={session.signIn} />
        <button
          type="button"
          className="topbar-btn"
          disabled={ws.connection !== "connected"}
          onClick={() => setCommitOpen(true)}
        >
          Commit…
        </button>
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
        <nav className="workspace-rail" aria-label="Workspace panels">
          {(["files", "editor", "agents"] as const).map((name) => (
            <button key={name} type="button" title={name[0].toUpperCase() + name.slice(1)} aria-label={name === "files" ? "Show files" : name === "editor" ? "Show editor" : "Show agents"}
              aria-pressed={name === "files" ? layout.filesVisible : name === "agents" ? layout.agentsVisible : panel === name}
              aria-controls={`panel-${name}`} onClick={() => name === "editor" ? showPanel(name) : togglePanel(name)}>
              <WorkspaceIcon name={name} /><span>{name}</span>
            </button>
          ))}
          <button type="button" aria-label="Review changes" title="Review changes" disabled={ws.connection !== "connected"} onClick={() => setCommitOpen(true)}>
            <WorkspaceIcon name="branch" /><span>Changes</span>
          </button>
          <CrownMark className="rail-crown" />
        </nav>
        <nav className="tree" id="panel-files" aria-label="Explorer">
          <div className="panel-controls"><span>FILES</span><button type="button" aria-label="Collapse explorer" title="Collapse explorer" onClick={() => { setLayout((l) => ({ ...l, filesVisible: false })); showPanel("editor"); }}>‹</button></div>
          <FileTree
            paths={ws.tree}
            locks={ws.locks}
            changes={ws.changes}
            members={ws.members}
            selfId={ws.self?.userId ?? null}
            openPath={openPath}
            loading={ws.connection !== "connected"}
            onOpen={(path) => { setOpenPath(path); setPanel("editor"); }}
          />
          <section className="branch-people" aria-label="Branch presence">
            <h2 className="section-label">In this branch <span>{ws.members.length}</span></h2>
            {ws.members.map((member) => (
              <div className="person-row" key={member.userId}>
                <Avatar name={member.name} url={member.avatarUrl} size={24} tone={member.userId === ws.self?.userId ? "self" : "other"} />
                <div><strong>{member.userId === ws.self?.userId ? "You" : member.name}</strong>
                  <small title={(member.userId === ws.self?.userId ? openPath : member.openPath) ?? undefined}>
                    {(member.userId === ws.self?.userId ? openPath : member.openPath)
                      ? `Viewing ${member.userId === ws.self?.userId ? openPath : member.openPath}` : "In the workspace"}
                  </small>
                </div>
              </div>
            ))}
            {ws.members.length === 0 && <p className="run-note">Waiting for workspace presence…</p>}
          </section>
          <p className="ownership-note"><WorkspaceIcon name="lock" />One writer. Everyone in sync.</p>
        </nav>
        {layout.filesVisible && <ResizeHandle label="Resize explorer" value={explorerWidth} min={190} max={Math.max(190, Math.min(520, sideBudget - (layout.agentsVisible ? agentWidth : 0)))}
          onChange={(explorer) => setLayout((l) => ({ ...l, explorer }))} onReset={() => setLayout((l) => ({ ...l, explorer: defaultLayout.explorer }))} />}
        <main className="workspace-main" id="panel-editor" tabIndex={-1}>
          <div className="workbench-toolbar"><span>WORKSPACE</span><span className="spacer" />
            <button type="button" aria-label="Toggle activity" aria-expanded={layout.activityVisible} onClick={() => setLayout((l) => ({ ...l, activityVisible: !l.activityVisible }))}>Activity</button>
            <button type="button" aria-label="Reset panel layout" onClick={() => setLayout(defaultLayout)}>Reset layout</button>
          </div>
          {openPath && manager ? (
            <Suspense fallback={<p className="editor-note">Starting editor…</p>}>
              <EditorPane
                manager={manager}
                path={openPath}
                connected={ws.connection === "connected"}
                selfId={ws.self?.userId ?? null}
                members={ws.members}
                onPauseRun={(runId) => socket?.emit("run:pause", { runId }, () => {})}
              />
            </Suspense>
          ) : (
            <div className="workspace-welcome">
              <CrownMark />
              <p className="section-label">Your shared workspace</p>
              <h1>Good work grows here.</h1>
              <p>Open a file. Give your agent a task.<br />Build together, with clear ownership.</p>
              <button type="button" className="btn-secondary" onClick={() => showPanel("files")}>Browse files</button>
            </div>
          )}
          {layout.activityVisible && <ResizeHandle label="Resize activity" axis="y" reverse value={activityHeight} min={90} max={Math.max(90, Math.min(360, available.height * 0.4))}
            onChange={(activity) => setLayout((l) => ({ ...l, activity }))} onReset={() => setLayout((l) => ({ ...l, activity: defaultLayout.activity }))} />}
          <div className="activity-dock" hidden={!layout.activityVisible}><BranchActivity ws={ws} onCollapse={() => setLayout((l) => ({ ...l, activityVisible: false }))} /></div>
        </main>
        {layout.agentsVisible && <ResizeHandle label="Resize agents" reverse value={agentWidth} min={240} max={Math.max(240, Math.min(520, sideBudget - (layout.filesVisible ? explorerWidth : 0)))}
          onChange={(agents) => setLayout((l) => ({ ...l, agents }))} onReset={() => setLayout((l) => ({ ...l, agents: defaultLayout.agents }))} />}
        <div className="agent-column" id="panel-agents">
          <div className="panel-controls"><span>AGENT WORKSPACE</span><button type="button" aria-label="Collapse agents" title="Collapse agents" onClick={() => { setLayout((l) => ({ ...l, agentsVisible: false })); showPanel("editor"); }}>›</button></div>
          {socket && <RunsColumn ws={ws} socket={socket} branch={branch} />}
        </div>
      </div>
      <footer className="workspace-footer">
        <span><WorkspaceIcon name="branch" />{branch}</span>
        <span>{ws.changes.size} changed {ws.changes.size === 1 ? "file" : "files"}</span>
        <span className="spacer" />
        <span>{ws.locks.size} active {ws.locks.size === 1 ? "lock" : "locks"}</span>
        <span className="footer-edition">PINEAGENT / CROWN</span>
      </footer>
    </div>
  );
}

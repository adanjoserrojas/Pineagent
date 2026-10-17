import { useEffect, useState } from "react";
import type { WorkspaceSocket } from "../net/socket";
import { plantBridge } from "../plant/bridge";
import type { WorkspaceState } from "../state/workspace";
import { RunPanel } from "./RunPanel";
import { plantFace } from "./runs";

const TICK_MS = 500; // re-evaluates time-based faces (done → idle, team overlays)

// Owns the clock for the plant so only this column re-renders on each tick, and feeds every
// face change to the plant bridge (the on-screen plant and, later, the real one over Web Serial).
export function RunsColumn({ ws, socket, branch }: { ws: WorkspaceState; socket: WorkspaceSocket; branch: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const plant = plantFace(ws.runs.values(), ws.self?.userId ?? null, { connection: ws.connection, now, team: ws.team });
  useEffect(() => plantBridge.update(plant.face), [plant.face]);

  return (
    <RunPanel
      socket={socket}
      runs={ws.runs}
      selfId={ws.self?.userId ?? null}
      members={ws.members}
      branch={branch}
      plant={plant}
      connected={ws.connection === "connected"}
    />
  );
}

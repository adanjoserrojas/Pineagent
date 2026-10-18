import { io, type Socket } from "socket.io-client";
import {
  UNAUTHENTICATED,
  type ClientToServerEvents,
  type RoomJoinAck,
  type ServerToClientEvents,
} from "../contracts/socket";
import { applyRunEvent, mergeRuns } from "../runs/runs";
import type { WorkspaceStore } from "../state/workspace";

export type WorkspaceSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const JOIN_TIMEOUT_MS = 5000;

export function connectWorkspace(opts: {
  apiUrl: string;
  wsId: string;
  branch: string;
  getToken: () => Promise<string>;
  store: WorkspaceStore;
}): WorkspaceSocket {
  const { store } = opts;
  const socket: WorkspaceSocket = io(opts.apiUrl, {
    // Called on every (re)connect, so a refreshed Auth0 token is picked up automatically.
    auth: (cb) => {
      opts.getToken().then(
        (token) => cb({ token }),
        () => cb({ token: "" }),
      );
    },
  });

  // Socket.IO does not restore room membership after a reconnect, so join on every connect.
  socket.on("connect", async () => {
    try {
      const res: RoomJoinAck = await socket.timeout(JOIN_TIMEOUT_MS).emitWithAck("room:join", { wsId: opts.wsId, branch: opts.branch });
      if (!res.ok) {
        store.set({ connection: res.code === "UNAVAILABLE" ? "unavailable" : "forbidden" });
        return;
      }
      store.set({
        connection: "connected",
        self: res.self,
        members: res.members,
        locks: new Map(res.locks.map((l) => [l.path, l])),
        tree: res.tree,
        timing: res.timing,
      });
      // Catch up on runs we missed while away; never replaces a newer snapshot.
      const { runs } = await socket.timeout(JOIN_TIMEOUT_MS).emitWithAck("run:list", {});
      store.set({ runs: mergeRuns(store.get().runs, runs) });
    } catch {
      // No ack in time: drop the connection and let the manager retry.
      socket.disconnect().connect();
    }
  });

  socket.on("disconnect", () => {
    store.set({ connection: socket.active ? "reconnecting" : "offline" });
  });

  socket.on("connect_error", (err) => {
    const code = (err as Error & { data?: { code?: string } }).data?.code;
    if (code === UNAUTHENTICATED) store.set({ connection: "unauthenticated" });
    else store.set({ connection: socket.active ? "reconnecting" : "offline" });
  });

  socket.on("run:event", (e) => {
    const runs = applyRunEvent(store.get().runs, e);
    if (runs) store.set({ runs });
  });

  socket.on("git:queue", ({ jobs }) => store.set({ gitQueue: jobs }));
  socket.on("git:changes", ({ changes }) => store.set({ changes: new Map(changes.map((c) => [c.path, c.status])) }));
  socket.on("git:result", (result) => store.set({ lastGitResult: result }));

  // A rebase can add or delete files under everyone; so can someone creating a file or folder.
  socket.on("tree:changed", ({ path, change, newPath }) => {
    // An empty folder's "dir/" entry goes once something is created inside it.
    const tree = store.get().tree.filter((p) => p !== path && !(change === "add" && p.endsWith("/") && path.startsWith(p)));
    if (change === "add") tree.push(path);
    if (change === "rename" && newPath) tree.push(newPath);
    store.set({ tree: tree.sort() });
  });

  // A new Map each time, so subscribers can tell the lock table changed by reference.
  socket.on("lock:changed", (m) => {
    const locks = new Map(store.get().locks);
    if (m.lock) locks.set(m.path, m.lock);
    else locks.delete(m.path);
    store.set({ locks });
  });

  socket.on("presence:changed", (m) => {
    const members = store.get().members;
    const prev = members.find((x) => x.userId === m.userId);
    const others = members.filter((x) => x.userId !== m.userId);
    if (m.status === "left") {
      store.set({ members: others, team: { kind: "team_leave", at: Date.now() } });
      return;
    }
    if (m.status === "joined" && !prev) store.set({ team: { kind: "team_join", at: Date.now() } });
    const member = {
      userId: m.userId,
      name: m.name,
      avatarUrl: m.avatarUrl ?? prev?.avatarUrl ?? null,
      openPath: m.openPath ?? null,
    };
    // Keep list order stable on "updated" so avatars don't jump around.
    store.set({ members: prev ? members.map((x) => (x.userId === m.userId ? member : x)) : [...others, member] });
  });

  return socket;
}

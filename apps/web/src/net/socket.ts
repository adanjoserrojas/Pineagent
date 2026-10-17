import { io, type Socket } from "socket.io-client";
import {
  UNAUTHENTICATED,
  type ClientToServerEvents,
  type RoomJoinAck,
  type ServerToClientEvents,
} from "../contracts/socket";
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
        store.set({ connection: "forbidden" });
        return;
      }
      store.set({
        connection: "connected",
        self: res.self,
        members: res.members,
        locks: new Map(res.locks.map((l) => [l.path, l])),
        tree: res.tree,
      });
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

  socket.on("presence:changed", (m) => {
    const members = store.get().members;
    const prev = members.find((x) => x.userId === m.userId);
    const others = members.filter((x) => x.userId !== m.userId);
    if (m.status === "left") {
      store.set({ members: others });
      return;
    }
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

import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../../mock/workspace";
import type { Lock, Op } from "../../src/contracts/socket";
import { FileSession, type SessionPort } from "../../src/editor/FileSession";
import { applyOps } from "../../src/shared/ops";
import { coveringDirLock } from "../../src/tree/model";

// Two users' FileSessions wired to the real mock Workspace through an in-memory "network"
// whose links can be cut, and whose broadcasts can be dropped.

const FIXTURE = fileURLToPath(new URL("../../mock/fixtures/demo-repo", import.meta.url));
const PATH = "src/auth.ts";

type Client = {
  id: string;
  online: boolean;
  session: FileSession;
  editor: { text: string }; // stands in for Monaco's buffer
  sent: number; // file:ops requests that reached the server
  failNextAck: boolean; // the server applies the batch but the ack never arrives
};

let now: number;
let ws: Workspace;
let clients: Client[];
let dropNextBroadcastTo: string | null;

const settle = () => new Promise((r) => setTimeout(r, 5));
async function settleAll(n = 6) {
  for (let i = 0; i < n; i++) await settle();
}

function locksMap(): Map<string, Lock> {
  return new Map(ws.allLocks().map((l) => [l.path, l]));
}

function notifyLocks() {
  for (const c of clients) if (c.online) c.session.lockChanged();
}

function makeClient(id: string): Client {
  const c = { id, online: true, editor: { text: "" }, sent: 0, failNextAck: false } as Client;
  const port: SessionPort = {
    connected: () => c.online,
    selfId: () => id,
    lockFor: (p) => locksMap().get(p) ?? coveringDirLock(p, locksMap()),
    acquire: async (p) => {
      await settle();
      if (!c.online) throw new Error("offline");
      const r = ws.acquire(p, "file", id);
      if (r.ok && r.created) notifyLocks();
      return r.ok ? { ok: true, lock: r.lock } : r;
    },
    sendOps: async (p, baseVersion, ops) => {
      await settle();
      if (!c.online) throw new Error("offline");
      c.sent++;
      const r = await ws.applyOps(p, id, baseVersion, ops);
      if (r.ok) {
        for (const other of clients) {
          if (other === c || !other.online) continue;
          if (dropNextBroadcastTo === other.id) {
            dropNextBroadcastTo = null;
            continue;
          }
          other.session.remoteChanged({ path: p, version: r.version, ops, author: id, source: "editor" });
        }
      }
      if (c.failNextAck) {
        c.failNextAck = false;
        throw new Error("ack timeout");
      }
      return r;
    },
    snapshot: async (p) => {
      await settle();
      if (!c.online) throw new Error("offline");
      const f = await ws.read(p);
      return f ? { ok: true, path: p, version: f.version, content: f.content, hash: "" } : { ok: false, code: "NOT_FOUND" };
    },
    release: (p) => {
      if (ws.release(p, id)) notifyLocks();
    },
  };
  c.session = new FileSession(PATH, port);
  c.session.bind({
    replace: (text) => (c.editor.text = text),
    apply: (ops) => (c.editor.text = applyOps(c.editor.text, ops)!),
  });
  return c;
}

// The user types: the editor changes its buffer first, then reports the ops.
function type(c: Client, ops: Op[]) {
  c.editor.text = applyOps(c.editor.text, ops)!;
  c.session.localEdit(ops);
}
const insert = (offset: number, text: string): Op[] => [{ offset, length: 0, text }];

async function flushAll() {
  for (let i = 0; i < 8; i++) {
    clients.forEach((c) => c.session.tick());
    await settleAll(3);
  }
}

async function serverText() {
  return (await ws.read(PATH))!.content;
}

let alice: Client;
let bob: Client;
let original: string;

beforeEach(async () => {
  now = 1_000_000;
  const root = await mkdtemp(join(tmpdir(), "pineagent-session-test-"));
  await cp(FIXTURE, root, { recursive: true });
  ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 }, () => now);
  dropNextBroadcastTo = null;
  clients = [];
  alice = makeClient("dev|alice");
  bob = makeClient("dev|bob");
  clients.push(alice, bob);
  alice.session.open();
  bob.session.open();
  await settleAll();
  original = await serverText();
});

describe("opening", () => {
  it("loads the snapshot into the editor and starts in viewing", () => {
    expect(alice.session.getState()).toMatchObject({ status: "viewing", version: 1, text: original });
    expect(alice.editor.text).toBe(original);
  });
});

describe("writing and viewing (L1, F1)", () => {
  it("the first keystroke takes the lock; edits reach the server and the viewer in order", async () => {
    type(alice, insert(0, "A"));
    expect(alice.session.getState().status).toBe("acquiring");
    await settleAll();
    expect(alice.session.getState().status).toBe("writing");
    expect(bob.session.getState()).toMatchObject({ status: "readonly", holder: { holder: "dev|alice" } });

    for (const ch of "BCDEF") {
      type(alice, insert(alice.editor.text.length, ch));
      alice.session.tick();
      await settle();
    }
    await flushAll();

    const server = await serverText();
    expect(server).toBe("A" + original + "BCDEF");
    for (const c of [alice, bob]) {
      expect(c.session.getState().text).toBe(server);
      expect(c.editor.text).toBe(server);
    }
    expect(await readFile(join(ws.root, PATH), "utf8")).toBe(server);
    expect(bob.session.getState().version).toBe(alice.session.getState().version);
  });

  it("keeps only one batch in flight", async () => {
    type(alice, insert(0, "x"));
    await settleAll();
    type(alice, insert(1, "y"));
    alice.session.tick();
    type(alice, insert(2, "z"));
    alice.session.tick(); // first batch still unacknowledged: must not send
    expect(alice.session.getState().inFlight).toBe(true);
    expect(alice.sent).toBe(0);
    await flushAll();
    expect(alice.sent).toBe(2); // "xy", then "z" on top of the acked version
    expect(await serverText()).toBe("xyz" + original);
  });
});

describe("conflicts (D1, L2)", () => {
  it("two people typing at once: exactly one wins, the other reverts and is told who", async () => {
    type(alice, insert(0, "alice"));
    type(bob, insert(0, "bob"));
    await settleAll();
    await flushAll();

    const states = [alice, bob].map((c) => c.session.getState());
    expect(states.map((s) => s.status).sort()).toEqual(["readonly", "writing"]);
    const loser = alice.session.getState().status === "readonly" ? alice : bob;
    const winner = loser === alice ? bob : alice;
    expect(loser.session.getState().heldNotice?.holder).toBe(winner.id);
    expect(loser.editor.text).toBe(await serverText());
    expect(await serverText()).toBe((winner === alice ? "alice" : "bob") + original);
  });

  it("with the lock map already showing a holder, a keystroke is undone without asking", async () => {
    type(alice, insert(0, "A"));
    await settleAll();
    type(bob, insert(0, "B"));
    expect(bob.editor.text).toBe(bob.session.getState().text);
    expect(bob.session.getState().status).toBe("readonly");
  });
});

describe("gaps and lost edits", () => {
  it("a missed broadcast is detected and the viewer resyncs (F2)", async () => {
    type(alice, insert(0, "1"));
    await settleAll();
    await flushAll();
    dropNextBroadcastTo = bob.id;
    type(alice, insert(1, "2"));
    await flushAll();
    type(alice, insert(2, "3"));
    await flushAll();
    expect(bob.editor.text).toBe(await serverText());
    expect(bob.session.getState().version).toBe(4);
  });

  it("an expired lease with unsent edits keeps a copy and reloads the server text (D2)", async () => {
    type(alice, insert(0, "saved "));
    await settleAll();
    await flushAll();
    alice.online = false; // Wi-Fi drops; heartbeats stop
    type(alice, insert(0, "unsaved "));
    now += 31_000;
    ws.sweep();
    alice.online = true;
    alice.session.reconnected();
    await settleAll();

    const s = alice.session.getState();
    expect(s.lostText).toBe("unsaved saved " + original);
    expect(s.text).toBe("saved " + original);
    expect(alice.editor.text).toBe(s.text);
    expect(s.status).toBe("viewing");
  });

  it("a server-side change under unsent edits (e.g. a formatter) also counts as lost edits", async () => {
    type(alice, insert(0, "a"));
    await settleAll();
    await flushAll();
    type(alice, insert(1, "b"));
    // The server's version moves without Alice: simulate a shell write by a co-holder path.
    alice.session.remoteChanged({ path: PATH, version: 3, ops: insert(0, "fmt "), author: "shell", source: "shell" });
    await settleAll();
    expect(alice.session.getState().lostText).toBe("ab" + original);
  });
});

describe("reconnect (F3, F4)", () => {
  it("a short drop with the lock still held resends the edits without losing anything", async () => {
    type(alice, insert(0, "a"));
    await settleAll();
    await flushAll();
    alice.online = false;
    type(alice, insert(1, "b"));
    alice.session.tick(); // can't send while offline
    alice.online = true;
    alice.session.reconnected();
    await flushAll();
    expect(alice.session.getState().lostText).toBeNull();
    expect(await serverText()).toBe("ab" + original);
    expect(bob.editor.text).toBe(await serverText());
  });

  it("an ack lost after the server applied the batch is not applied twice", async () => {
    type(alice, insert(0, "a"));
    await settleAll();
    await flushAll();
    alice.failNextAck = true;
    type(alice, insert(1, "b"));
    await flushAll();
    expect(await serverText()).toBe("ab" + original);
    expect(alice.session.getState()).toMatchObject({ status: "writing", lostText: null, text: "ab" + original });
  });

  it("a viewer that reconnects reloads to the current version", async () => {
    bob.online = false;
    type(alice, insert(0, "while bob was away "));
    await settleAll();
    await flushAll();
    bob.online = true;
    bob.session.reconnected();
    await settleAll();
    expect(bob.editor.text).toBe(await serverText());
  });
});

describe("leaving", () => {
  it("leaving a file flushes the last edits, then releases the lock", async () => {
    type(alice, insert(0, "last words "));
    await settleAll();
    alice.session.leave();
    expect(ws.allLocks()).toHaveLength(1); // still flushing
    await flushAll();
    expect(await serverText()).toBe("last words " + original);
    expect(ws.allLocks()).toEqual([]);
    expect(bob.session.getState().status).toBe("viewing");
  });
});

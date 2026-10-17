// Restart recovery for a branch's locks and file bookkeeping (contracts/SOCKET_LOCKS_AND_FILES.md
// rule 5). Memory stays the authority while the process runs; the store only answers "what was
// true when the server stopped?" The dev mock runs without one; services/api uses DynamoDB.
import type { Lock } from "../contracts";

// Only editor locks are kept. An agent run lives in this process, so its locks end with it.
export type StoredLock = Pick<Lock, "path" | "kind" | "holder">;
export type StoredFile = { path: string; version: number; editors: string[] };
export type RoomSnapshot = { locks: StoredLock[]; files: StoredFile[] };

export interface RoomStore {
  load(): Promise<RoomSnapshot>;
  putLock(lock: StoredLock): Promise<void>;
  deleteLock(path: string): Promise<void>;
  // The file's version after an edit or a Git refresh; `editor` joins the people who edited it.
  saveFile(path: string, version: number, editor?: string): Promise<void>;
  clearEditors(paths: string[]): Promise<void>;
}

export type Store = { room(roomId: string): RoomStore };

// For tests: outlives the Workspace and gateway that wrote to it, like a table outlives a process.
export class MemoryStore implements Store {
  readonly locks = new Map<string, StoredLock>();
  readonly files = new Map<string, StoredFile>();

  room(roomId: string): RoomStore {
    const key = (path: string) => `${roomId}\0${path}`;
    const inRoom = <T>(m: Map<string, T>) => [...m].filter(([k]) => k.startsWith(`${roomId}\0`)).map(([, v]) => structuredClone(v));
    return {
      load: async () => ({ locks: inRoom(this.locks), files: inRoom(this.files) }),
      putLock: async (lock) => void this.locks.set(key(lock.path), { ...lock }),
      deleteLock: async (path) => void this.locks.delete(key(path)),
      saveFile: async (path, version, editor) => {
        const f = this.files.get(key(path)) ?? { path, version, editors: [] };
        f.version = version;
        if (editor && !f.editors.includes(editor)) f.editors.push(editor);
        this.files.set(key(path), f);
      },
      clearEditors: async (paths) => {
        for (const p of paths) {
          const f = this.files.get(key(p));
          if (f) f.editors = [];
        }
      },
    };
  }
}

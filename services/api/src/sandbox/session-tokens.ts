import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { User } from "@pineagent/core/server";

type Grant = { user: User; hash: string };
// Opaque, process-local capabilities. Restart revokes all sessions. Never store
// Auth0/provider credentials in a sandbox, or log/serialize the returned token.
export class SessionTokens {
  readonly #grants = new Map<string, Grant>();
  readonly #hashes = new Map<string, string>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(owner: User, roomId: string, ttlMs = 5 * 60_000): { token: string; id: string; expiresAt: number } {
    if (owner.session || !owner.id || !roomId || roomId.length > 500 || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 15 * 60_000) throw new Error("Invalid scoped session");
    for (const [id, grant] of this.#grants) if (grant.user.session!.expiresAt <= this.now()) this.revoke(id);
    if (this.#grants.size >= 4096) throw new Error("Session capacity reached");
    const token = `pst_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const id = randomUUID(), expiresAt = this.now() + ttlMs;
    const user: User = { id: owner.id, name: owner.name, avatarUrl: owner.avatarUrl, session: { id, roomId, expiresAt } };
    this.#grants.set(id, { user, hash });
    this.#hashes.set(hash, id);
    return { token, id, expiresAt };
  }

  authenticate(token: unknown): User | null {
    if (typeof token !== "string" || !/^pst_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const id = this.#hashes.get(createHash("sha256").update(token).digest("hex"));
    const grant = id ? this.#grants.get(id) : undefined;
    return grant && this.active(grant.user) ? structuredClone(grant.user) : null;
  }

  active(user: User): boolean {
    const session = user.session;
    if (!session) return false;
    const grant = this.#grants.get(session.id);
    return Boolean(grant && grant.user.id === user.id && grant.user.session!.roomId === session.roomId && grant.user.session!.expiresAt > this.now());
  }

  revoke(id: string): void {
    const grant = this.#grants.get(id);
    if (grant) this.#hashes.delete(grant.hash);
    this.#grants.delete(id);
  }
}

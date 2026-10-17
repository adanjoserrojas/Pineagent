// Per-user GitHub access through Auth0's token vault.
//
//   server ──signed assertion──► Auth0 /oauth/token        → Management API token (cached)
//   server ──Management token──► Auth0 /api/v2/users/{sub} → that user's GitHub token (cached 5 min)
//   server ──user's token──────► GitHub                    → can they push? clone/fetch/push as them
//
// The server proves who it is with a private key (private_key_jwt), so there is no shared client
// secret anywhere. GitHub tokens stay in this process: never sent to a browser, logged, or written.
import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT, type CryptoKey } from "jose";

export type Fetch = typeof fetch;

export type RepoAccess =
  | { ok: true; fullName: string; sizeKb: number }
  | { ok: false; code: "NOT_COLLABORATOR" | "UNAVAILABLE"; why: string };

const USER_TOKEN_TTL_MS = 5 * 60_000;

export class GitHubBroker {
  private mgmt: { token: string; until: number } | null = null;
  private readonly tokens = new Map<string, { token: Promise<string>; until: number }>();
  private key: Promise<CryptoKey> | null = null;

  constructor(
    private readonly opts: {
      domain: string;
      clientId: string;
      privateKeyPem: () => Promise<string>;
      githubApi: string;
      fetch?: Fetch;
      now?: () => number;
    },
  ) {}

  private get fetch(): Fetch {
    return this.opts.fetch ?? fetch;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  // Client credentials grant, authenticated with a short-lived JWT signed by our private key.
  private async managementToken(): Promise<string> {
    if (this.mgmt && this.mgmt.until > this.now()) return this.mgmt.token;
    this.key ??= this.opts.privateKeyPem().then((pem) => importPKCS8(pem, "RS256"));
    const tokenUrl = `https://${this.opts.domain}/oauth/token`;
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.opts.clientId)
      .setSubject(this.opts.clientId)
      .setAudience(tokenUrl)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(await this.key);
    const res = await this.fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.opts.clientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        audience: `https://${this.opts.domain}/api/v2/`,
      }),
    });
    if (!res.ok) throw new Error(`Auth0 token endpoint answered ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    // Renew a minute early so a token never expires mid-request.
    this.mgmt = { token: body.access_token, until: this.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  }

  // The GitHub token Auth0 stored when this user signed in with GitHub.
  githubToken(userId: string): Promise<string> {
    const hit = this.tokens.get(userId);
    if (hit && hit.until > this.now()) return hit.token;
    const token = this.lookup(userId);
    this.tokens.set(userId, { token, until: this.now() + USER_TOKEN_TTL_MS });
    token.catch(() => this.tokens.delete(userId));
    return token;
  }

  private async lookup(userId: string): Promise<string> {
    if (!userId.startsWith("github|")) throw new Error("not a GitHub account");
    const url = `https://${this.opts.domain}/api/v2/users/${encodeURIComponent(userId)}?fields=identities&include_fields=true`;
    const res = await this.fetch(url, { headers: { Authorization: `Bearer ${await this.managementToken()}` } });
    if (!res.ok) throw new Error(`Auth0 users endpoint answered ${res.status}`);
    const { identities = [] } = (await res.json()) as { identities?: { provider: string; access_token?: string }[] };
    const token = identities.find((i) => i.provider === "github")?.access_token;
    if (!token) throw new Error("Auth0 has no GitHub token for this user (re-sign-in needed?)");
    return token;
  }

  // Forget a token GitHub rejected (revoked, or scopes changed) so the next request looks it up again.
  forget(userId: string) {
    this.tokens.delete(userId);
  }

  // Can this user push to owner/repo? Asked with the user's own token, so GitHub decides.
  async access(userId: string, owner: string, repo: string): Promise<RepoAccess> {
    let token: string;
    try {
      token = await this.githubToken(userId);
    } catch (err) {
      return { ok: false, code: "UNAVAILABLE", why: (err as Error).message };
    }
    const res = await this.fetch(`${this.opts.githubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (res.status === 401) this.forget(userId);
    if (res.status === 404) return { ok: false, code: "NOT_COLLABORATOR", why: "repository not found for this user" };
    if (!res.ok) return { ok: false, code: "UNAVAILABLE", why: `GitHub answered ${res.status}` };
    const body = (await res.json()) as { full_name: string; size: number; permissions?: { push?: boolean } };
    if (!body.permissions?.push) return { ok: false, code: "NOT_COLLABORATOR", why: "no push access" };
    return { ok: true, fullName: body.full_name, sizeKb: body.size };
  }
}

// Turns an Auth0 token from the Socket.IO handshake into a user, or null.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { githubAvatarUrl } from "../contracts";

export type User = {
  id: string; // Auth0 sub, e.g. "github|583231"
  name: string; // GitHub login when known
  avatarUrl: string | null;
  // Backend-issued CLI capability, never copied from unverified JWT claims.
  session?: { id: string; roomId: string; expiresAt: number };
};

export type Auth0Options = {
  domain: string; // tenant, e.g. "dev-xyz.us.auth0.com"
  audience: string; // the API identifier (or the SPA client id for ID tokens in dev)
  jwks?: JWTVerifyGetKey; // tests pass a local key set
  // Profile lookup for tokens without profile claims (API access tokens). Defaults to /userinfo.
  userinfo?: (token: string) => Promise<Record<string, unknown>>;
  warn?: (msg: string) => void;
};

// Verifies signature (RS256 from the tenant's published keys), issuer and audience. API access
// tokens carry no name or picture, so the profile comes from Auth0's /userinfo, once per user.
export function auth0Verifier(opts: Auth0Options): (token: unknown) => Promise<User | null> {
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(`https://${opts.domain}/.well-known/jwks.json`));
  const userinfo = opts.userinfo ?? defaultUserinfo(opts.domain);
  const warn = opts.warn ?? ((m) => console.warn(m));
  const profiles = new Map<string, Promise<Record<string, unknown>>>();

  const profileOf = (sub: string, token: string) => {
    let p = profiles.get(sub);
    if (!p) {
      // A failed lookup isn't cached, and the user still gets in, named by their sub.
      p = userinfo(token).catch((err) => {
        profiles.delete(sub);
        warn(`couldn't load the Auth0 profile: ${(err as Error).message}`);
        return {};
      });
      profiles.set(sub, p);
    }
    return p;
  };

  return async (token) => {
    if (typeof token !== "string" || !token) return null;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `https://${opts.domain}/`,
        audience: opts.audience,
        algorithms: ["RS256"],
      });
      const sub = String(payload.sub);
      const profile = typeof payload.nickname === "string" ? payload : await profileOf(sub, token);
      const claim = (k: string) => (typeof profile[k] === "string" ? (profile[k] as string) : undefined);
      return {
        id: sub,
        name: claim("nickname") ?? claim("name") ?? sub,
        avatarUrl: githubAvatarUrl(sub) ?? claim("picture") ?? null,
      };
    } catch (err) {
      warn(`rejected Auth0 token: ${(err as Error).message}`);
      return null;
    }
  };
}

function defaultUserinfo(domain: string) {
  return async (token: string) => {
    const res = await fetch(`https://${domain}/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`userinfo ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
}

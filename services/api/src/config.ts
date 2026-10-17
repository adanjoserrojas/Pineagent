// Everything the server needs from its environment (/etc/pineagent/env on the box), checked at
// start: a missing value stops the process with a clear message instead of failing on first use.
// Nothing here is secret; the Auth0 key is read from a file only the service user can open.

export type Config = {
  host: string;
  port: number;
  sha: string; // the deployed commit, shown on /health
  workspacesRoot: string;
  allowedOrigins: string[];
  allowedRepos: Set<string>; // lower-cased "owner/repo"
  auth0: { domain: string; audience: string };
  m2m: { clientId: string; keyFile: string } | null; // null = GitHub access not configured yet
  githubApi: string;
  githubClone: string; // clone URL prefix; "https://github.com" in production
  dynamo: { region: string; locks: string; files: string } | null; // null = locks and versions in memory only
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v ?? "";
  };
  const list = (k: string) =>
    need(k)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const config: Config = {
    host: env.HOST?.trim() || "127.0.0.1", // only Caddy, on the same machine, talks to Node
    port: Number(env.PORT ?? 3001),
    sha: env.RELEASE_SHA?.trim() || "dev",
    workspacesRoot: need("WORKSPACES_ROOT"),
    allowedOrigins: list("ALLOWED_ORIGINS"),
    allowedRepos: new Set(list("ALLOWED_REPOS").map((r) => r.toLowerCase())),
    auth0: { domain: need("AUTH0_DOMAIN"), audience: need("AUTH0_AUDIENCE") },
    m2m:
      env.AUTH0_M2M_CLIENT_ID?.trim() && env.AUTH0_M2M_KEY_FILE?.trim()
        ? { clientId: env.AUTH0_M2M_CLIENT_ID.trim(), keyFile: env.AUTH0_M2M_KEY_FILE.trim() }
        : null,
    githubApi: env.GITHUB_API?.trim() || "https://api.github.com",
    githubClone: env.GITHUB_CLONE?.trim() || "https://github.com",
    dynamo: env.DYNAMODB_LOCKS_TABLE?.trim()
      ? { region: need("AWS_REGION"), locks: env.DYNAMODB_LOCKS_TABLE.trim(), files: need("DYNAMODB_FILES_TABLE") }
      : null,
  };
  if (missing.length) throw new Error(`missing configuration: ${missing.join(", ")}`);
  if (!Number.isInteger(config.port) || config.port <= 0) throw new Error("PORT must be a port number");
  return config;
}

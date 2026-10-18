// The production server: the shared gateway, wired to Auth0, GitHub and real clones on disk.
// Built from parts so tests can swap the outside world (Auth0 keys, GitHub, the clone URL) for fakes.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import {
  createGateway,
  GitRepo,
  noHarness,
  tokenEnv,
  type HarnessFactory,
  type JoinContext,
  type Store,
  type User,
  type GatewayOptions,
} from "@pineagent/core/server";
import type { Config } from "./config";
import type { GitHubBroker } from "./github";
import type { SessionTokens } from "./sandbox/session-tokens";

// Bigger repositories take too long to clone during a demo and fill the disk.
const MAX_REPO_KB = 500_000;
const ACCESS_TTL_MS = 60_000;

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export type AppDeps = {
  config: Config;
  authenticate: (token: unknown) => Promise<User | null>;
  github: Pick<GitHubBroker, "access" | "githubToken"> | null; // null = GitHub access not configured
  harness?: HarnessFactory; // SE1's harness, once it exists
  store?: Store | null; // null = locks and versions are lost on restart
  sessions?: SessionTokens;
  protect?: GatewayOptions["protect"];
  terminal?: GatewayOptions["terminal"];
  pty?: GatewayOptions["pty"];
  log: Log;
};

export function createApp({ config, authenticate, github, harness = noHarness, store = null, sessions, protect, terminal, pty, log }: AppDeps) {
  const started = Date.now();
  let storeErrors = 0;
  const logged: Log = (event, fields) => {
    if (event === "store.failed") storeErrors++;
    log(event, fields);
  };
  const http: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          sha: config.sha,
          uptimeS: Math.round((Date.now() - started) / 1000),
          github: Boolean(github),
          harness: harness !== noHarness,
          terminal: Boolean(terminal),
          interactiveTerminal: Boolean(pty),
          store: store ? { errors: storeErrors } : null,
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });

  // Join decisions are cached briefly: every reconnect re-joins, and GitHub rate-limits.
  const verdicts = new Map<string, { at: number; verdict: "ok" | "NOT_COLLABORATOR" | "UNAVAILABLE" }>();

  async function authorize({ wsId, user }: JoinContext): Promise<"ok" | "NOT_COLLABORATOR" | "UNAVAILABLE"> {
    const [owner, repo] = wsId.split("/");
    if (!repo) return "UNAVAILABLE"; // the server only opens GitHub repositories
    if (!config.allowedRepos.has(wsId.toLowerCase())) return "UNAVAILABLE";
    if (!github) return "UNAVAILABLE";
    const key = `${user.id} ${wsId.toLowerCase()}`;
    const hit = verdicts.get(key);
    if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return hit.verdict;
    const access = await github.access(user.id, owner, repo);
    const verdict = access.ok ? (access.sizeKb > MAX_REPO_KB ? "UNAVAILABLE" : "ok") : access.code;
    if (!access.ok) log("github.refused", { user: user.id, repo: wsId, why: access.why });
    verdicts.set(key, { at: Date.now(), verdict });
    return verdict;
  }

  // /workspaces/<owner>/<repo>/<branch, URL-encoded so "a" and "a/b" can't nest>
  async function prepare({ wsId, branch, user }: JoinContext): Promise<GitRepo> {
    const [owner, repo] = wsId.toLowerCase().split("/");
    const dir = join(config.workspacesRoot, owner, repo, encodeURIComponent(branch));
    // An existing clone is reused as-is: after a restart, uncommitted work is still there.
    if (existsSync(join(dir, ".git"))) return new GitRepo(dir, branch);
    await mkdir(dirname(dir), { recursive: true });
    const token = await github!.githubToken(user.id);
    log("git.clone", { repo: wsId, branch, user: user.id });
    return GitRepo.clone(`${config.githubClone}/${owner}/${repo}.git`, dir, branch, tokenEnv(token));
  }

  const gateway = createGateway({
    http,
    allowedOrigins: config.allowedOrigins,
    authenticate: async (token) => typeof token === "string" && token.startsWith("pst_")
      ? sessions?.authenticate(token) ?? null : authenticate(token),
    sessionActive: (user) => sessions?.active(user) ?? false,
    protect,
    terminal,
    pty,
    authorize,
    prepare,
    gitCredentials: async (userId) => (github ? tokenEnv(await github.githubToken(userId)) : {}),
    // GitHub links a commit to an account by its noreply address: <numeric id>+<login>@...
    author: (u) => {
      const id = u.id.match(/^github\|(\d+)$/)?.[1];
      return { id: u.id, name: u.name, email: id ? `${id}+${u.name}@users.noreply.github.com` : `${u.name}@users.noreply.github.com` };
    },
    harness,
    store: store ?? undefined,
    log: logged,
  });

  return {
    http,
    gateway,
    listen: () => new Promise<void>((resolve) => http.listen(config.port, config.host, resolve)),
    close: async () => {
      const closed = gateway.close();
      http.closeAllConnections();
      await closed;
    },
  };
}

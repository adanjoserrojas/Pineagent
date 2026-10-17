// Entry point on the server (systemd runs `node /opt/pineagent/current/api/server.mjs`).
import { readFile } from "node:fs/promises";
import { auth0Verifier } from "@pineagent/core/server";
import { createApp, type Log } from "./app";
import { loadConfig } from "./config";
import { GitHubBroker } from "./github";

// One JSON object per line; journald keeps them. Never tokens or file contents.
const log: Log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

const config = loadConfig();
const github = config.m2m
  ? new GitHubBroker({
      domain: config.auth0.domain,
      clientId: config.m2m.clientId,
      privateKeyPem: () => readFile(config.m2m!.keyFile, "utf8"),
      githubApi: config.githubApi,
    })
  : null;
if (!github) log("github.not_configured", { hint: "set AUTH0_M2M_CLIENT_ID and AUTH0_M2M_KEY_FILE" });

const app = createApp({
  config,
  authenticate: auth0Verifier({ ...config.auth0, warn: (m) => log("auth.warn", { message: m }) }),
  github,
  log,
});

await app.listen();
log("server.listening", { host: config.host, port: config.port, sha: config.sha, repos: [...config.allowedRepos] });

// systemd sends SIGTERM on stop and restart: stop taking connections, let in-flight writes land.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("server.stopping", { signal });
    void app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

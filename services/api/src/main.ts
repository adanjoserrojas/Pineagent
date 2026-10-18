// Entry point on the server (systemd runs `node /opt/pineagent/current/api/server.mjs`).
import { readFile } from "node:fs/promises";
import { auth0Verifier } from "@pineagent/core/server";
import { createApp, type Log } from "./app";
import { loadConfig } from "./config";
import { dynamoClient, DynamoStore } from "./dynamo";
import { GitHubBroker } from "./github";
import { liveRuntime } from "./harness/runtime";
import { SessionTokens } from "./sandbox/session-tokens";

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
const store = config.dynamo ? new DynamoStore(dynamoClient(config.dynamo.region), config.dynamo) : null;
if (!store) log("store.not_configured", { hint: "set DYNAMODB_LOCKS_TABLE, DYNAMODB_FILES_TABLE and AWS_REGION" });

const sessions = new SessionTokens();
const runtime = await liveRuntime(process.env, log, sessions);
const app = createApp({
  config,
  authenticate: auth0Verifier({ ...config.auth0, warn: (m) => log("auth.warn", { message: m }) }),
  github,
  store,
  log,
  ...runtime,
  sessions,
});

await app.listen();
log("server.listening", { host: config.host, port: config.port, sha: config.sha, repos: [...config.allowedRepos], store: Boolean(store) });

// systemd sends SIGTERM on stop and restart: stop taking connections, let in-flight writes land.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("server.stopping", { signal });
    void app.close().then(() => { runtime?.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 150_000).unref();
  });
}

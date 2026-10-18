import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { GatewayOptions, Workspace } from "@pineagent/core/server";
import { createFrozenRouter } from "@pineagent/harness";
import { bedrockTransport, OpusRun } from "../models/bedrock";
import { SandboxClient } from "../sandbox/broker";
import { RoomSandbox } from "../sandbox/room";
import { LiveHarness } from "./controller";

/** Explicit opt-in; missing providers/supervisor fail startup rather than silently running locally. */
export async function liveRuntime(env: NodeJS.ProcessEnv, log: (event: string, fields?: Record<string, unknown>) => void) {
  if (env.HARNESS_ENABLED !== "true") return null;
  if (!env.AWS_REGION || !env.SANDBOX_SOCKET || !env.DECISIONS_SECRET_ID) throw new Error("Configure AWS_REGION, SANDBOX_SOCKET and DECISIONS_SECRET_ID before enabling harness");
  const secrets = new SecretsManagerClient({ region: env.AWS_REGION, maxAttempts: 1 });
  const key = async (id: string) => {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: id }), { abortSignal: AbortSignal.timeout(10_000) });
    const value = response.SecretString?.trim();
    if (!value || value.length > 4096) throw new Error("Invalid router secret configuration");
    if (value.startsWith("{")) {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || !("apiKey" in parsed) || typeof parsed.apiKey !== "string" || !parsed.apiKey.trim()) throw new Error("Expected plaintext key or apiKey field");
      return parsed.apiKey.trim();
    }
    return value;
  };
  let decisionsApiKey: string, jevApiKey: string | undefined;
  try {
    decisionsApiKey = await key(env.DECISIONS_SECRET_ID);
    jevApiKey = env.JEV_SECRET_ID ? await key(env.JEV_SECRET_ID) : undefined;
  } finally { secrets.destroy(); }
  const service = new SandboxClient(env.SANDBOX_SOCKET);
  const transport = bedrockTransport(env.AWS_REGION);
  const rooms = new WeakMap<Workspace, RoomSandbox>();
  const sandbox = (ws: Workspace) => {
    const room = rooms.get(ws);
    if (!room) throw new Error("Workspace sandbox protection is missing");
    return room;
  };
  const wiring: Pick<GatewayOptions, "protect" | "harness" | "terminal"> = {
    protect: async ws => {
      await service.quiesce(ws.root);
      rooms.set(ws, new RoomSandbox(ws, service));
    },
    harness: context => new LiveHarness({ context,
      model: (ownerId, runId) => new OpusRun({ ownerId, runId, transport: transport.send }),
      router: () => createFrozenRouter({ decisionsApiKey, jevApiKey }),
      runTests: (ownerId, runId, path) => sandbox(context.ws).runTests(ownerId, runId, path),
      receipt: (runId, result) => log("harness.result", { runId, ...result }),
    }),
    terminal: (ws, ownerId, line) => sandbox(ws).parseCommand(ownerId, line),
  };
  return { ...wiring, close: () => transport.close() };
}

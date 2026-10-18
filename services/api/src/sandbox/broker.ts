import { createServer, request, type IncomingMessage } from "node:http";
import type { SandboxHost, SandboxSession, SandboxExecution, CommandResult } from "./host";

export type SandboxService = Pick<SandboxHost, "ensure" | "execute" | "quiesce">;
const LIMIT = 65_536;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 8192 && !value.includes("\0");
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 128 && value.every(text);

function session(value: Record<string, unknown>): SandboxSession | null {
  return text(value.workspace) && text(value.owner) && strings(value.grants)
    ? { workspace: value.workspace, owner: value.owner, grants: value.grants } : null;
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw new RangeError("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Listen ONLY on the private Unix socket in supervisor.ts. Filesystem ownership
// is the authentication boundary; this server is never a public TCP listener.
export function createSandboxBroker(host: SandboxService) {
  return createServer({ requestTimeout: 150_000, headersTimeout: 10_000 }, async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) abort.abort(); });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || !["/open", "/execute", "/quiesce"].includes(req.url ?? "")) return send(404, { error: "NOT_FOUND" });
    if (Number(req.headers["content-length"]) > LIMIT) { req.resume(); return send(413, { error: "TOO_LARGE" }); }
    let value: unknown;
    try { value = await body(req); }
    catch (error) { return send(error instanceof RangeError ? 413 : 400, { error: "BAD_REQUEST" }); }
    if (!record(value)) return send(400, { error: "BAD_REQUEST" });
    try {
      if (req.url === "/quiesce") {
        if (!text(value.workspace)) return send(400, { error: "BAD_REQUEST" });
        await host.quiesce(value.workspace);
        return send(200, { ok: true });
      }
      const scoped = session(value);
      if (!scoped) return send(400, { error: "BAD_REQUEST" });
      if (req.url === "/open") {
        if (!Number.isFinite(value.deadline)) return send(400, { error: "BAD_REQUEST" });
        return send(200, { name: await host.ensure(scoped, { deadline: Math.min(value.deadline as number, Date.now() + 120_000), signal: abort.signal }) });
      }
      if (!strings(value.argv) || !value.argv.length || !Number.isInteger(value.timeoutMs)
        || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 120_000) return send(400, { error: "BAD_REQUEST" });
      if (!text(value.generation)) return send(400, { error: "BAD_REQUEST" });
      return send(200, await host.execute({ ...scoped, generation: value.generation }, value.argv, value.timeoutMs as number));
    } catch { return send(503, { error: "SANDBOX_UNAVAILABLE" }); } // no host paths, command text, or secrets
  });
}

// Public API-side client. It has access to this narrow socket, never Docker.
export class SandboxClient implements SandboxService {
  constructor(private readonly socketPath: string) {
    if (!socketPath.startsWith("/") && !socketPath.startsWith("\\\\.\\pipe\\")) throw new Error("Expected private supervisor socket");
  }
  private call(path: string, value: unknown): Promise<unknown> {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > LIMIT) return Promise.reject(new Error("Sandbox request too large"));
    return new Promise((done, reject) => {
      const req = request({ socketPath: this.socketPath, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 300_000) { res.destroy(); reject(new Error("Sandbox response too large")); }
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("Sandbox unavailable"));
          try { done(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(new Error("Invalid sandbox response")); }
        });
      });
      const deadline = setTimeout(() => req.destroy(new Error("Sandbox request deadline")), 150_000);
      req.on("close", () => clearTimeout(deadline));
      req.on("error", reject);
      req.end(data);
    });
  }
  async ensure(session: SandboxSession): Promise<string> {
    const response = await this.call("/open", { ...session, deadline: Date.now() + 120_000 });
    if (!record(response) || !text(response.name)) throw new Error("Invalid sandbox response");
    return response.name;
  }
  async execute(session: SandboxExecution, argv: string[], timeoutMs = 120_000): Promise<CommandResult> {
    const response = await this.call("/execute", { ...session, argv, timeoutMs });
    if (!record(response) || typeof response.stdout !== "string" || typeof response.stderr !== "string" || !Number.isInteger(response.code)) throw new Error("Invalid sandbox response");
    return { stdout: response.stdout, stderr: response.stderr, code: response.code as number };
  }
  async quiesce(workspace: string): Promise<void> {
    const response = await this.call("/quiesce", { workspace });
    if (!record(response) || response.ok !== true) throw new Error("Invalid sandbox revocation response");
  }
}

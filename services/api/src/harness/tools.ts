import { extname } from "node:path";
import type { Op } from "@pineagent/core/contracts";
import { MAX_FILE_BYTES, type Workspace } from "@pineagent/core/server";
import type { FileSnapshot, TestResult, ToolEvent, ToolRuntime } from "@pineagent/harness";
import { taskTerms } from "../../../../harness/dist/src/sandbox-tools.js";

type Snapshot = { content: string; version: number };
export type EvidenceVersions = Map<string, Snapshot>;
const TEXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md"]);

/** Backend authority adapter. No direct filesystem mutation or host processes. */
export class BackendTools implements ToolRuntime {
  outputLimit: number;
  readonly events: ToolEvent[] = [];
  readonly observations: EvidenceVersions;
  constructor(private readonly options: {
    ws: Workspace; ownerId: string; runId: string; allowedWrites: string[];
    files(): Promise<string[]>;
    runTests(testPath?: string | null): Promise<TestResult>;
    changed(path: string, version: number, ops: Op[], author: string): void;
    boundary(): Promise<void>;
    progress?(event: ToolEvent): void;
    observations?: EvidenceVersions; outputLimit?: number;
  }) {
    this.outputLimit = options.outputLimit ?? 48_000;
    this.observations = options.observations ?? new Map();
  }

  private async record<T>(name: string, input: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
    await this.options.boundary();
    const start = performance.now();
    try {
      const value = await operation();
      const event: ToolEvent = { name, input, status: "ok", ms: Math.round(performance.now() - start) };
      this.events.push(event); this.options.progress?.(event);
      return value;
    } catch (error) {
      const event: ToolEvent = { name, input, status: "error", ms: Math.round(performance.now() - start), error: "Backend tool refused or failed" };
      this.events.push(event); this.options.progress?.(event);
      throw error;
    }
  }

  listFiles(): Promise<string[]> {
    return this.record("list_files", {}, async () => {
      const files = (await this.options.files()).filter(path => this.options.ws.resolvePath(path)
        && !path.split("/").includes("node_modules"));
      if (files.length > 4000) throw new Error("Repository exceeds bounded discovery limit");
      return [...new Set(files)].sort();
    });
  }

  async readText(path: string): Promise<string> {
    await this.options.boundary();
    if (!this.options.ws.resolvePath(path)) throw new Error("Unsafe evidence path");
    const file = await this.options.ws.read(path);
    if (!file) throw new Error("Evidence file is unavailable or unsupported");
    const old = this.observations.get(path);
    if (old && (old.version !== file.version || old.content !== file.content)) throw new Error("Evidence changed; a fresh run is required");
    this.observations.set(path, { ...file });
    if ([...this.observations.values()].reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0) > 16_000_000) throw new Error("Repository exceeds local evidence budget");
    return file.content;
  }

  searchCode(query: string | string[]): Promise<{ path: string; score: number }[]> {
    return this.record("search_code", {}, async () => {
      const terms = Array.isArray(query) ? query : taskTerms(query);
      const hits: { path: string; score: number }[] = [];
      for (const path of await this.listFiles()) {
        if (!TEXT.has(extname(path).toLowerCase())) continue;
        const text = (await this.readText(path)).toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (path.toLowerCase().includes(term)) score += 12;
          score += Math.min(text.split(term).length - 1, 8);
        }
        if (score > 0) hits.push({ path, score });
      }
      return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 20);
    });
  }

  readFiles(paths: string[]): Promise<FileSnapshot[]> {
    return this.record("read_files", { paths }, async () => {
      let remaining = this.outputLimit;
      const result: FileSnapshot[] = [];
      for (const path of [...new Set(paths)].slice(0, 12)) {
        const content = (await this.readText(path)).slice(0, remaining);
        result.push({ path, content });
        remaining -= content.length;
        if (remaining <= 0) break;
      }
      return result;
    });
  }

  async assertFresh(): Promise<void> {
    for (const [path, seen] of this.observations) {
      const current = await this.options.ws.read(path);
      if (!current || current.version !== seen.version || current.content !== seen.content) throw new Error("Evidence changed; a fresh run is required");
    }
  }

  writeFiles(files: FileSnapshot[]): Promise<string[]> {
    return this.record("write_files", {}, async () => {
      if (!files.length || files.length > 12 || new Set(files.map(f => f.path)).size !== files.length) throw new Error("Invalid bounded patch");
      for (const file of files) {
        if (!this.options.allowedWrites.includes(file.path) || !this.observations.has(file.path)
          || typeof file.content !== "string" || file.content.includes("\0") || Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw new Error("Patch outside observed write scope");
        const lock = this.options.ws.allLocks().find(l => l.path === file.path && l.runId === this.options.runId
          && l.holder === this.options.ownerId && l.holderType === "run");
        if (!lock) throw new Error("Run no longer owns its write set");
      }
      await this.assertFresh();
      for (const file of files) {
        const seen = this.observations.get(file.path)!;
        const ops = [{ offset: 0, length: seen.content.length, text: file.content }];
        const result = await this.options.ws.applyOps(file.path, this.options.ownerId, seen.version, ops, this.options.runId);
        if (!result.ok) throw new Error(`Workspace rejected patch: ${result.code}`);
        this.observations.set(file.path, { content: file.content, version: result.version });
        this.options.changed(file.path, result.version, ops, `agent-run/${this.options.runId}`);
      }
      return files.map(file => file.path);
    });
  }

  runTests(testPath: string | null = null): Promise<TestResult> {
    return this.record("run_tests", { testPath }, async () => {
      if (testPath && !this.options.ws.resolvePath(testPath)) throw new Error("Unsafe test path");
      return this.options.runTests(testPath);
    });
  }
}

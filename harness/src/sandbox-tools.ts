import type { SpawnOptionsWithoutStdio } from "node:child_process";
import type { FileSnapshot, ToolEvent, TestResult } from "./types.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { benchmarkEnvironment } from "./benchmark-environment.js";

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md"]);
const STOP_WORDS = new Set([
  "about", "after", "against", "before", "behavior", "change", "code", "continue", "file",
  "from", "function", "implement", "invalid", "keep", "make", "missing", "must", "only",
  "repository", "return", "should", "smallest", "source", "tests", "that", "their", "this",
  "through", "values", "while", "with", "within",
]);

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isWithin(relative: string, allowedWrites: string[]): boolean {
  const normalized = normalizeRelative(relative);
  return allowedWrites.some((candidate) => {
    const prefix = normalizeRelative(candidate).replace(/\/$/, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function runProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, shell: false, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.stdout!.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-48_000); });
    child.stderr!.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-48_000); });
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", exitCode => { cleanup(); if (stopped) reject(new Error("Verification cancelled or timed out")); else resolve({ exitCode, stdout, stderr }); });
  });
}

export function taskTerms(task: string): string[] {
  const identifiers = task.match(/[A-Za-z_$][A-Za-z0-9_$-]*/g) ?? [];
  return [...new Set(identifiers
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 4 && !STOP_WORDS.has(term)))]
    .slice(0, 18);
}

export class SandboxToolRuntime {
  private readonly testTimeoutMs: number;
  private readonly signal?: AbortSignal;
  declare root: string; declare allowedWrites: string[]; declare outputLimit: number; declare events: ToolEvent[];
  constructor({ root, allowedWrites, outputLimit = 20_000, testTimeoutMs = 120_000, signal }: { root: string; allowedWrites: string[]; outputLimit?: number; testTimeoutMs?: number; signal?: AbortSignal }) {
    if (!Number.isInteger(testTimeoutMs) || testTimeoutMs < 1 || testTimeoutMs > 120_000) throw new Error("Invalid verification deadline");
    this.testTimeoutMs = testTimeoutMs;
    this.signal = signal;
    this.root = path.resolve(root);
    this.allowedWrites = allowedWrites;
    this.outputLimit = outputLimit;
    this.events = [];
  }

  async record<T>(name: string, input: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const output = await operation();
      this.events.push({ name, status: "ok", ms: Math.round(performance.now() - started), input });
      return output;
    } catch (error) {
      this.events.push({ name, status: "error", ms: Math.round(performance.now() - started), input, error: (error as Error).message });
      throw error;
    }
  }

  resolve(relative: string): { normalized: string; absolute: string } {
    const normalized = normalizeRelative(relative);
    if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`Unsafe relative path: ${relative}`);
    }
    const absolute = path.resolve(this.root, normalized);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Path escapes sandbox: ${relative}`);
    }
    return { normalized, absolute };
  }

  async listFiles(): Promise<string[]> {
    return this.record("list_files", {}, async () => {
      const result: string[] = [];
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (["node_modules", ".git"].includes(entry.name)) continue;
          const absolute = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await visit(absolute);
          else if (entry.isFile()) result.push(normalizeRelative(path.relative(this.root, absolute)));
        }
      };
      await visit(this.root);
      return result.sort();
    });
  }

  async searchCode(query: string | string[]): Promise<{ path: string; score: number }[]> {
    return this.record("search_code", { query }, async () => {
      const terms = Array.isArray(query) ? query : taskTerms(String(query));
      const files = await this.listFiles();
      const hits: { path: string; score: number }[] = [];
      for (const relative of files) {
        if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
        const { absolute } = this.resolve(relative);
        const text = await fs.readFile(absolute, "utf8");
        let score = 0;
        const lowerPath = relative.toLowerCase();
        const lowerText = text.toLowerCase();
        for (const term of terms) {
          if (lowerPath.includes(term)) score += 12;
          const matches = lowerText.split(term).length - 1;
          score += Math.min(matches, 8);
        }
        if (score > 0) hits.push({ path: relative, score });
      }
      return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 20);
    });
  }

  async readFiles(paths: string[]): Promise<FileSnapshot[]> {
    return this.record("read_files", { paths }, async () => {
      const result: FileSnapshot[] = [];
      let remaining = this.outputLimit;
      for (const relative of [...new Set(paths)].slice(0, 12)) {
        const { normalized, absolute } = this.resolve(relative);
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const text = await fs.readFile(absolute, "utf8");
        const content = text.slice(0, remaining);
        remaining -= content.length;
        result.push({ path: normalized, content });
        if (remaining <= 0) break;
      }
      return result;
    });
  }

  async readText(relative: string): Promise<string> {
    const { absolute } = this.resolve(relative);
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error("Unsupported evidence file");
    return fs.readFile(absolute, "utf8");
  }

  async writeFiles(files: FileSnapshot[]): Promise<string[]> {
    return this.record("write_files", { paths: files.map((file) => file.path) }, async () => {
      if (!Array.isArray(files) || files.length === 0) throw new Error("Patch contained no files");
      const written = [];
      for (const file of files) {
        const { normalized, absolute } = this.resolve(file.path);
        if (!isWithin(normalized, this.allowedWrites)) throw new Error(`Write outside scope: ${normalized}`);
        for (let cursor = path.dirname(absolute); cursor.startsWith(this.root) && cursor !== this.root; cursor = path.dirname(cursor)) {
          try {
            if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink path rejected: ${normalized}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, file.content, "utf8");
        written.push(normalized);
      }
      return written;
    });
  }

  async runTests(testPath: string | null = null): Promise<TestResult> {
    return this.record("run_tests", { testPath }, async () => {
      const args = ["--test"];
      if (testPath) args.push(this.resolve(testPath).absolute);
      const result = await runProcess(process.execPath, args, { cwd: this.root, env: benchmarkEnvironment() }, this.testTimeoutMs, this.signal);
      return {
        exitCode: result.exitCode,
        output: `${result.stdout}\n${result.stderr}`.slice(-this.outputLimit),
      };
    });
  }
}

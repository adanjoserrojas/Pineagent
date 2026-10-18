import type { HarnessContext } from "@pineagent/core/server";

const TEXT = /\.(?:md|txt|json|toml|ini|cfg|py|js|mjs|cjs|ts|tsx|jsx|rs|go|java|c|h|cpp|cs|rb|php|html|css)$/i;
const EXCLUDED = /(?:^|\/)(?:\.[^/]*|node_modules|venv|__pycache__|site-packages|dist|build|target|vendor|coverage)(?:\/|$)|(?:secret|credential|password|token|private[-_]?key)|(?:^|\/)(?:package-lock\.json|Cargo\.lock)$/i;

/** Read-only capability: no router, lock, process or write interface is exposed. */
export async function readQuestionEvidence(context: HarnessContext, task: string, boundary: () => Promise<void>) {
  await boundary();
  const files = await context.files();
  if (files.length > 4000) throw new Error("Repository exceeds bounded discovery limit");
  const safe = [...new Set(files)].filter(path => context.ws.resolvePath(path) && TEXT.test(path) && !EXCLUDED.test(path));
  const words = task.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? [];
  const score = (path: string) => (/^readme\.md$/i.test(path) ? 100 : 0)
    + (/^(package\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(path) ? 40 : 0)
    + words.filter(word => path.toLowerCase().includes(word)).length * 10;
  safe.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  const seen: { path: string; content: string; version: number }[] = [];
  const evidence: { path: string; content: string; truncated: boolean }[] = [];
  let remaining = 24000;
  for (const path of safe.slice(0, 12)) {
    await boundary();
    const file = await context.ws.read(path);
    if (!file) continue;
    seen.push({ path, ...file });
    const content = file.content.slice(0, Math.min(6000, remaining));
    evidence.push({ path, content, truncated: content.length < file.content.length });
    remaining -= content.length;
    if (remaining <= 0) break;
  }
  return {
    evidence: JSON.stringify({ scope: "Bounded repository sample, not an exhaustive review", files: evidence }),
    paths: evidence.map(file => file.path),
    async assertFresh() {
      await boundary();
      for (const file of seen) {
        const current = await context.ws.read(file.path);
        if (!current || current.version !== file.version || current.content !== file.content) throw new Error("Evidence changed; a fresh run is required");
      }
    },
  };
}

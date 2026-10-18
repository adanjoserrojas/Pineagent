import { posix as path } from "node:path";
import type { RepositoryLanguage } from "./types.js";

const ignored = /(^|\/)(node_modules|\.git|dist|build|coverage|vendor)\//;
const source = (file: string) => /\.(?:[cm]?js|tsx?)$/.test(file) && !ignored.test(file);
export const isJavaScriptTest = (file: string) => /(^|\/)(tests?|__tests__)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
/** Conservative literal import discovery; never executes repository code.
 * Dynamic expressions, bundler aliases and package export maps require more evidence. */
export const javascriptLanguage: RepositoryLanguage = {
  isSource: file => source(file) && !isJavaScriptTest(file),
  isGraphFile: source,
  permitsRecovery: file => source(file) || ["package.json", "tsconfig.json"].includes(file),
  manifests: ["package.json", "tsconfig.json"],
  references(file, content, available) {
    const found = new Set<string>();
    const literals = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)["'](\.[^"']+)["']/g;
    for (const match of content.matchAll(literals)) {
      const base = path.normalize(path.join(path.dirname(file), match[1]));
      if (base.startsWith("../")) continue;
      const candidates = [base, ...[".js", ".mjs", ".cjs", ".ts", ".tsx", "/index.js", "/index.mjs", "/index.cjs", "/index.ts"].map(ext => base + ext)];
      if (base.endsWith(".js")) candidates.push(base.slice(0, -3) + ".ts");
      const resolved = candidates.find(candidate => available.has(candidate));
      if (resolved) found.add(resolved);
    }
    return [...found].sort();
  },
};

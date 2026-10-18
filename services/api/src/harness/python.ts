import { posix as path } from "node:path";
import type { RepositoryLanguage } from "@pineagent/harness";

const ignored = new Set([".git", ".venv", "venv", "__pycache__", "site-packages", "node_modules"]);
const pythonFile = (file: string) => file.endsWith(".py") && !file.split("/").some(part => ignored.has(part));
const testFile = (file: string) => /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/.test(file) || /(^|\/)(tests?|testing)\//.test(file);
const manifests = ["pyproject.toml", "requirements.txt", "pytest.ini", "setup.cfg"];

/** Static, conservative import discovery. Never imports/evaluates repository code.
 * Dynamic imports and custom import hooks remain unsupported, not inferred. */
export const pythonLanguage: RepositoryLanguage = {
  isSource: file => pythonFile(file) && !testFile(file),
  isGraphFile: pythonFile,
  permitsRecovery: file => pythonFile(file) || manifests.includes(file),
  manifests,
  references(file, content, available) {
    if (!pythonFile(file)) return [];
    const result = new Set<string>();
    const add = (module: string) => {
      if (!/^(?:\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\.+)$/.test(module)) return;
      const dots = module.match(/^\.+/)?.[0].length ?? 0;
      let base = dots ? path.dirname(file) : "";
      for (let i = 1; i < dots; i++) base = path.dirname(base);
      if (dots > path.dirname(file).split("/").filter(p => p !== ".").length) return;
      const suffix = module.slice(dots).replaceAll(".", "/");
      const roots = dots ? [path.join(base, suffix)] : [suffix, path.join("src", suffix)];
      for (const root of roots) {
        for (const candidate of [`${root}.py`, path.join(root, "__init__.py")]) {
          if (available.has(candidate) && pythonFile(candidate)) result.add(candidate);
        }
        // Package initializers are part of Python's actual import execution.
        let parent = path.dirname(root);
        while (parent !== "." && parent !== "/") {
          const init = path.join(parent, "__init__.py");
          if (available.has(init)) result.add(init);
          parent = path.dirname(parent);
        }
      }
    };
    // Join parenthesized imports and continuations, but only inspect import lines.
    const lines = content.replace(/\\\r?\n/g, " ").replace(/(from\s+[.\w]+\s+import\s*\()([^)]*)(\))/g,
      (_match, start: string, names: string, end: string) => start + names.replace(/\r?\n/g, " ") + end);
    for (const line of lines.split(/\r?\n/)) {
      const from = /^\s*from\s+([.\w]+)\s+import\s+(.+?)(?:#.*)?$/.exec(line);
      if (from) {
        add(from[1]);
        for (const name of from[2].replace(/[()]/g, "").split(",")) {
          const imported = name.trim().split(/\s+/)[0];
          add(from[1] + (from[1].endsWith(".") ? "" : ".") + imported);
        }
      } else {
        const direct = /^\s*import\s+(.+?)(?:#.*)?$/.exec(line);
        for (const name of direct?.[1].split(",") ?? []) add(name.trim().split(/\s+/)[0]);
      }
    }
    return [...result].sort();
  },
};

/** Select only supported validators; a mixed-language write plan must be replanned. */
export function languageForPlan(plan: { visibleTestPath: string; allowedWrites: string[]; createPaths?: string[] }): RepositoryLanguage | undefined {
  if (pythonFile(plan.visibleTestPath)) {
    if (!testFile(plan.visibleTestPath) || !plan.allowedWrites.every(file => pythonLanguage.isSource(file)
      || (plan.createPaths?.includes(file) && pythonFile(file) && testFile(file)))) throw new Error("Unsupported Python write/test scope");
    return pythonLanguage;
  }
  if (!/\.[cm]?js$/.test(plan.visibleTestPath) || plan.allowedWrites.some(file => file.endsWith(".py"))) throw new Error("Unsupported verification language");
  return undefined;
}

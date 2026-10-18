import { isJavaScriptTest } from "@pineagent/harness";

export type FeaturePlan = { allowedWrites: string[]; visibleTestPath: string; createPaths?: string[]; acceptanceCriteria?: string[] };
export const safeFeaturePath = (value: unknown): value is string => typeof value === "string" && value.length <= 400
  && !/[\\:\x00-\x1f\x7f]/.test(value)
  && value.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith(".") && !/[. ]$/.test(part)
    && !["node_modules", "venv", "__pycache__", "dist", "build"].includes(part));
export const isAcceptanceTest = (path: string) => isJavaScriptTest(path)
  || /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(path);

/** Validate model plans before acquiring authority. New paths are inferred from
 * the trusted inventory; a model cannot relabel an existing file as a creation. */
export function validateFeaturePlan(value: unknown, files: readonly string[]): FeaturePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid feature plan");
  const plan = value as Record<string, unknown>;
  if (!Array.isArray(plan.allowedWrites) || plan.allowedWrites.length < 1 || plan.allowedWrites.length > 12
    || !plan.allowedWrites.every(safeFeaturePath) || new Set(plan.allowedWrites).size !== plan.allowedWrites.length
    || !safeFeaturePath(plan.visibleTestPath)) throw new Error("Invalid feature plan");
  const allowedWrites = plan.allowedWrites as string[], visibleTestPath = plan.visibleTestPath;
  if (allowedWrites.some(path => files.includes(path) && (isAcceptanceTest(path) || path === visibleTestPath)))
    throw new Error("Existing verification files are immutable");
  const createPaths = allowedWrites.filter(path => !files.includes(path));
  if (!files.includes(visibleTestPath) && (!createPaths.includes(visibleTestPath) || !isAcceptanceTest(visibleTestPath)))
    throw new Error("Feature requires an existing or explicitly planned acceptance test");
  let acceptanceCriteria: string[] | undefined;
  if (plan.acceptanceCriteria !== undefined) {
    if (!Array.isArray(plan.acceptanceCriteria) || !plan.acceptanceCriteria.length || plan.acceptanceCriteria.length > 8
      || !plan.acceptanceCriteria.every(value => typeof value === "string" && value.trim() && value.length <= 500)) throw new Error("Invalid acceptance criteria");
    acceptanceCriteria = plan.acceptanceCriteria.map(value => (value as string).trim());
  }
  if (createPaths.length && !acceptanceCriteria) throw new Error("New features require measurable acceptance criteria");
  return { allowedWrites, visibleTestPath, ...(createPaths.length ? { createPaths } : {}), ...(acceptanceCriteria ? { acceptanceCriteria } : {}) };
}

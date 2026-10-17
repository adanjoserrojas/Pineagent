import type { ToolDefinition } from "./types.js";

export const prototypeTools: ToolDefinition[] = [
  {
    name: "run_failing_test",
    routeLabel: "failure_first_diagnosis",
    routeDescription:
      "Use only when the task text is not a sufficient behavioral specification and a deterministic visible failure is needed to reveal the expected/actual boundary, error, or location. Run that failure first, then inspect only files identified by its evidence. Do not choose merely because a test exists.",
    description:
      "Run the already identified failing test first and use its assertion and stack trace to locate the defect.",
    requiredTools: [],
    requires: [],
    provides: ["located_context"],
    writes: [],
    maxRepeats: 1,
    timeoutMs: 30_000,
  },
  {
    name: "search_code",
    routeLabel: "targeted_symbol_search",
    routeDescription:
      "Use this least-cost route when the task text specifies the behavior and names concrete functions, exports, symbols, or distinctive source concepts. It may cover multiple files when their symbols are explicitly named. Search those terms directly and inspect only the strongest source matches; no test evidence is gathered before synthesis.",
    description:
      "Search for symbols and behavior named by the task, then narrow the implementation to the matching files.",
    requiredTools: [],
    requires: [],
    provides: ["located_context"],
    writes: [],
    maxRepeats: 1,
    timeoutMs: 30_000,
  },
  {
    name: "map_repository",
    routeLabel: "repository_flow_mapping",
    routeDescription:
      "Use only when source ownership is unclear and correctness requires following a cross-file flow such as configuration into startup or an adapter. Map the repository and read multiple connected modules. Do not choose when named symbols make targeted search sufficient.",
    description:
      "Inspect the small repository structure before choosing the files involved in a cross-file change.",
    requiredTools: [],
    requires: [],
    provides: ["located_context"],
    writes: [],
    maxRepeats: 1,
    timeoutMs: 30_000,
  },
  {
    name: "read_target_files",
    description: "Read only the source and tests identified by the selected discovery route.",
    requiredTools: [],
    requires: ["located_context"],
    provides: ["source_context"],
    writes: [],
    maxRepeats: 1,
    timeoutMs: 30_000,
  },
  {
    name: "edit_code",
    description: "Make the smallest source change that satisfies the task.",
    requiredTools: [],
    requires: ["source_context"],
    provides: ["changed_code"],
    writes: ["$TASK_WRITE_SET"],
    maxRepeats: 1,
    timeoutMs: 120_000,
  },
  {
    name: "run_targeted_tests",
    description: "Run the most relevant visible test after the edit.",
    requiredTools: [],
    requires: ["changed_code"],
    provides: ["target_verified"],
    writes: [],
    maxRepeats: 1,
    timeoutMs: 30_000,
  },
  {
    name: "run_full_tests",
    description: "Run the full visible test suite and report the final result.",
    requiredTools: ["run_targeted_tests"],
    requires: [],
    provides: ["verified_change"],
    writes: [],
    maxRepeats: 1,
    timeoutMs: 30_000,
  },
];

export function validateRegistry(tools: ToolDefinition[]): void {
  const names = new Set();
  for (const tool of tools) {
    if (!tool.name || names.has(tool.name)) {
      throw new Error(`Tool names must be present and unique: ${tool.name}`);
    }
    names.add(tool.name);
    for (const field of ["requiredTools", "requires", "provides", "writes"] as const) {
      if (!Array.isArray(tool[field])) throw new Error(`${tool.name}.${field} must be an array`);
    }
    if (!Number.isInteger(tool.maxRepeats) || tool.maxRepeats < 1) {
      throw new Error(`${tool.name}.maxRepeats must be a positive integer`);
    }
  }
  for (const tool of tools) {
    for (const required of tool.requiredTools) {
      if (!names.has(required)) throw new Error(`${tool.name} requires missing tool ${required}`);
    }
  }
}

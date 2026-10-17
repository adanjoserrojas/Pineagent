import type { ToolDefinition, DagCandidate } from "./types.js";
type Plan = { nodes: Map<string, ToolDefinition>; edges: Set<string>; roots: string[] };

import { stableId } from "./canonical.js";
import { validateRegistry } from "./registry.js";

function cartesian<T>(groups: T[][]): T[][] {
  return groups.reduce(
    (products, group) => products.flatMap((product) => group.map((item) => [...product, item])),
    [[]] as T[][],
  );
}

function emptyPlan(): Plan {
  return { nodes: new Map(), edges: new Set(), roots: [] };
}

function mergePlans(plans: Plan[]): Plan {
  const merged = emptyPlan();
  for (const plan of plans) {
    for (const [name, tool] of plan.nodes) merged.nodes.set(name, tool);
    for (const edge of plan.edges) merged.edges.add(edge);
    merged.roots.push(...plan.roots);
  }
  merged.roots = [...new Set(merged.roots)].sort();
  return merged;
}

function addEdge(plan: Plan, from: string, to: string): void {
  if (from !== to) plan.edges.add(`${from}->${to}`);
}

function hasPath(edges: Set<string>, start: string, end: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const encoded of edges) {
    const [from, to] = encoded.split("->");
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(to);
  }
  const stack = [start];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === end) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === "$TASK_WRITE_SET" || right === "$TASK_WRITE_SET") return true;
  const a = left.replaceAll("\\", "/").replace(/\/$/, "");
  const b = right.replaceAll("\\", "/").replace(/\/$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function hasParallelWriteConflict(plan: Plan): boolean {
  const writers = [...plan.nodes.values()].filter((tool) => tool.writes.length > 0);
  for (let i = 0; i < writers.length; i += 1) {
    for (let j = i + 1; j < writers.length; j += 1) {
      const left = writers[i];
      const right = writers[j];
      const overlap = left.writes.some((a) => right.writes.some((b) => pathsOverlap(a, b)));
      const ordered = hasPath(plan.edges, left.name, right.name) || hasPath(plan.edges, right.name, left.name);
      if (overlap && !ordered) return true;
    }
  }
  return false;
}

function topologicalOrder(plan: Plan): string[] {
  const names = [...plan.nodes.keys()].sort();
  const incoming = new Map(names.map((name) => [name, 0]));
  const outgoing = new Map<string, string[]>(names.map((name) => [name, []]));
  for (const encoded of plan.edges) {
    const [from, to] = encoded.split("->");
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    outgoing.get(from)?.push(to);
  }
  const ready = names.filter((name) => incoming.get(name) === 0).sort();
  const ordered = [];
  while (ready.length) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const next of (outgoing.get(current) ?? []).sort()) {
      incoming.set(next, incoming.get(next)! - 1);
      if (incoming.get(next) === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  if (ordered.length !== names.length) throw new Error("cycle");
  return ordered;
}

function longestDepth(plan: Plan, ordered: string[]): number {
  const depth = new Map(ordered.map((name) => [name, 1]));
  for (const name of ordered) {
    for (const encoded of plan.edges) {
      const [from, to] = encoded.split("->");
      if (from === name) depth.set(to, Math.max(depth.get(to)!, depth.get(from)! + 1));
    }
  }
  return Math.max(...depth.values(), 0);
}

export function selectCandidateDags({
  goalCapability,
  tools,
  maxDepth = 8,
  maxCandidates = 32,
}: { goalCapability: string; tools: ToolDefinition[]; maxDepth?: number; maxCandidates?: number }): DagCandidate[] {
  validateRegistry(tools);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const providers = new Map<string, ToolDefinition[]>();
  for (const tool of tools) {
    for (const capability of tool.provides) {
      if (!providers.has(capability)) providers.set(capability, []);
      providers.get(capability)!.push(tool);
      providers.get(capability)!.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  function expandCapability(capability: string, stack: string[]): Plan[] {
    const available = providers.get(capability) ?? [];
    return available.flatMap((tool) => expandTool(tool, stack));
  }

  function expandTool(tool: ToolDefinition, stack: string[]): Plan[] {
    if (stack.includes(tool.name)) return [];
    const nextStack = [...stack, tool.name];
    const exactGroups = tool.requiredTools.map((name) => expandTool(byName.get(name)!, nextStack));
    const capabilityGroups = tool.requires.map((capability) => expandCapability(capability, nextStack));
    const groups = [...exactGroups, ...capabilityGroups];
    if (groups.some((group) => group.length === 0)) return [];
    const combinations = groups.length ? cartesian(groups) : [[]];
    return combinations.map((combination) => {
      const plan = mergePlans(combination);
      plan.nodes.set(tool.name, tool);
      for (const dependency of combination) {
        for (const root of dependency.roots) addEdge(plan, root, tool.name);
      }
      plan.roots = [tool.name];
      return plan;
    });
  }

  const expanded = expandCapability(goalCapability, []);
  const candidates: DagCandidate[] = [];
  const seen = new Set();
  for (const plan of expanded) {
    if (hasParallelWriteConflict(plan)) continue;
    let order;
    try {
      order = topologicalOrder(plan);
    } catch {
      continue;
    }
    const depth = longestDepth(plan, order);
    if (depth > maxDepth) continue;
    const nodes = order.map((name) => {
      const tool = plan.nodes.get(name)!;
      return {
        name: tool.name,
        description: tool.description,
        writes: [...tool.writes].sort(),
        timeoutMs: tool.timeoutMs,
      };
    });
    const edges = [...plan.edges]
      .map((encoded) => encoded.split("->"))
      .sort(([a1, a2], [b1, b2]) => `${a1}:${a2}`.localeCompare(`${b1}:${b2}`));
    const canonical = { goalCapability, nodes, edges };
    const id = stableId(canonical);
    if (seen.has(id)) continue;
    seen.add(id);
    const discoveryTool = order.find((name) =>
      ["run_failing_test", "search_code", "map_repository"].includes(name),
    );
    const discoveryDefinition = discoveryTool ? plan.nodes.get(discoveryTool) : undefined;
    candidates.push({
      id,
      goalCapability,
      nodes,
      edges,
      order,
      depth,
      discoveryTool,
      routeLabel: (discoveryDefinition?.routeLabel ?? discoveryTool) as string,
      routeDescription: (discoveryDefinition?.routeDescription ?? discoveryDefinition?.description) as string,
    });
    if (candidates.length > maxCandidates) {
      throw new Error(`Candidate limit exceeded (${maxCandidates})`);
    }
  }
  return candidates.sort((a, b) => a.id.localeCompare(b.id));
}

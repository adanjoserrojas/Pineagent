import type { Lock } from "../contracts/socket";

// Directory paths carry a trailing slash, matching how the contract names directory locks ("src/K/").
export type TreeNode = { name: string; path: string; kind: "file" | "dir"; children: TreeNode[] };
export type Row = { node: TreeNode; depth: number };
export type Match = { path: string; start: number; end: number };

export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let dir = root;
    parts.forEach((name, i) => {
      if (i === parts.length - 1) {
        dir.children.push({ name, path, kind: "file", children: [] });
        return;
      }
      const dirPath = parts.slice(0, i + 1).join("/") + "/";
      let next = dir.children.find((c) => c.kind === "dir" && c.path === dirPath);
      if (!next) {
        next = { name, path: dirPath, kind: "dir", children: [] };
        dir.children.push(next);
      }
      dir = next;
    });
  }
  sortTree(root);
  return root.children;
}

function sortTree(node: TreeNode) {
  node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  node.children.forEach(sortTree);
}

export function allDirs(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "dir" ? [n.path, ...allDirs(n.children)] : []));
}

export function visibleRows(nodes: TreeNode[], expanded: ReadonlySet<string>, depth = 0): Row[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "dir" && expanded.has(node.path) ? visibleRows(node.children, expanded, depth + 1) : []),
  ]);
}

export function parentDir(path: string): string | null {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? null : trimmed.slice(0, i + 1);
}

export function filterPaths(paths: string[], query: string): Match[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return paths.flatMap((path) => {
    const start = path.toLowerCase().indexOf(q);
    return start < 0 ? [] : [{ path, start, end: start + q.length }];
  });
}

// The lock shown on a row: an exact file or directory lock on that path.
export function lockOn(path: string, locks: ReadonlyMap<string, Lock>): Lock | undefined {
  return locks.get(path);
}

// A directory lock that covers a file from above, shown as an inherited hint on the file row.
export function coveringDirLock(path: string, locks: ReadonlyMap<string, Lock>): Lock | undefined {
  for (let dir = parentDir(path); dir; dir = parentDir(dir)) {
    const lock = locks.get(dir);
    if (lock?.kind === "dir") return lock;
  }
  return undefined;
}

export function isLocked(path: string, locks: ReadonlyMap<string, Lock>): boolean {
  return Boolean(lockOn(path, locks) ?? coveringDirLock(path, locks));
}

const TYPE_TILES: Record<string, { label: string; tone: string }> = {
  ts: { label: "TS", tone: "code" },
  tsx: { label: "TSX", tone: "code" },
  js: { label: "JS", tone: "code" },
  jsx: { label: "JSX", tone: "code" },
  json: { label: "{}", tone: "data" },
  yml: { label: "YML", tone: "data" },
  yaml: { label: "YML", tone: "data" },
  md: { label: "MD", tone: "doc" },
  css: { label: "CSS", tone: "style" },
  html: { label: "<>", tone: "style" },
  py: { label: "PY", tone: "code" },
  ino: { label: "INO", tone: "code" },
  h: { label: "H", tone: "code" },
};

export function fileTile(name: string): { label: string; tone: string } {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return TYPE_TILES[ext] ?? { label: ext.slice(0, 3).toUpperCase() || "·", tone: "plain" };
}

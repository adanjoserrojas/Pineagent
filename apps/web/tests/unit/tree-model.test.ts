import { describe, expect, it } from "vitest";
import { githubAvatarUrl, type Lock } from "../../src/contracts/socket";
import { allDirs, buildTree, coveringDirLock, fileTile, filterPaths, isLocked, parentDir, visibleRows } from "../../src/tree/model";

const PATHS = ["README.md", "src/routes/users.ts", "src/auth.ts", "package.json", "src/routes/index.ts", "src/db.ts"];

const lock = (path: string, kind: Lock["kind"], holder = "github|1"): Lock => ({
  path,
  kind,
  holder,
  holderType: "user",
  expiresAt: 0,
});

describe("buildTree", () => {
  it("nests by directory and sorts folders before files", () => {
    const roots = buildTree(PATHS);
    expect(roots.map((n) => n.path)).toEqual(["src/", "package.json", "README.md"]);
    expect(roots[0].children.map((n) => n.path)).toEqual(["src/routes/", "src/auth.ts", "src/db.ts"]);
    expect(allDirs(roots)).toEqual(["src/", "src/routes/"]);
  });

  it("hides the children of collapsed folders", () => {
    const roots = buildTree(PATHS);
    const open = visibleRows(roots, new Set(["src/", "src/routes/"]));
    expect(open.find((r) => r.node.path === "src/routes/users.ts")?.depth).toBe(2);
    const closed = visibleRows(roots, new Set(["src/"]));
    expect(closed.map((r) => r.node.path)).not.toContain("src/routes/users.ts");
    expect(closed.map((r) => r.node.path)).toContain("src/routes/");
  });
});

describe("helpers", () => {
  it("finds parent directories", () => {
    expect(parentDir("src/routes/users.ts")).toBe("src/routes/");
    expect(parentDir("src/routes/")).toBe("src/");
    expect(parentDir("README.md")).toBeNull();
  });

  it("filters case-insensitively and reports the match range", () => {
    expect(filterPaths(PATHS, "USER")).toEqual([{ path: "src/routes/users.ts", start: 11, end: 15 }]);
    expect(filterPaths(PATHS, "  ")).toEqual([]);
  });

  it("treats a directory lock as covering every file below it", () => {
    const locks = new Map([["src/routes/", lock("src/routes/", "dir")]]);
    expect(coveringDirLock("src/routes/users.ts", locks)?.path).toBe("src/routes/");
    expect(coveringDirLock("src/auth.ts", locks)).toBeUndefined();
    expect(isLocked("src/routes/index.ts", locks)).toBe(true);
  });

  it("picks a type tile from the extension", () => {
    expect(fileTile("auth.ts")).toEqual({ label: "TS", tone: "code" });
    expect(fileTile("package.json").tone).toBe("data");
    expect(fileTile("Makefile").label).toBe("·");
  });

  it("derives a GitHub avatar only from github| subs", () => {
    expect(githubAvatarUrl("github|583231", 32)).toBe("https://avatars.githubusercontent.com/u/583231?s=32");
    expect(githubAvatarUrl("auth0|abc")).toBeNull();
    expect(githubAvatarUrl("dev|alice")).toBeNull();
  });
});

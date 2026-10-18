import { describe, expect, it } from "vitest";
import type { Lock } from "../../src/contracts/socket";
import { baseName, commitButtonView, describeActivity, githubLogin } from "../../src/ui/profile";

const lock = (path: string, holder: string, holderType: "user" | "run" = "user"): Lock => ({ path, kind: "file", holder, holderType, expiresAt: 1 });

describe("githubLogin", () => {
  it("uses the name for github sign-ins only", () => {
    expect(githubLogin({ userId: "github|107363449", name: "octo-cat" })).toBe("octo-cat");
    expect(githubLogin({ userId: "dev|alice", name: "alice" })).toBeNull();
  });
  it("refuses names that are not valid logins", () => {
    expect(githubLogin({ userId: "github|1", name: "../evil" })).toBeNull();
  });
});

describe("describeActivity", () => {
  it("says Editing when the open file is locked by them", () => {
    const a = describeActivity({ userId: "u", openPath: "a.ts" }, [lock("a.ts", "u"), lock("b.ts", "u"), lock("c.ts", "other")]);
    expect(a.summary).toBe("Editing a.ts");
    expect(a.otherLocks).toEqual(["b.ts"]);
  });
  it("says Viewing when only open, and ignores run locks for editing", () => {
    const a = describeActivity({ userId: "u", openPath: "a.ts" }, [lock("a.ts", "u", "run")]);
    expect(a.summary).toBe("Viewing a.ts");
    expect(a.runLocks).toEqual(["a.ts"]);
  });
  it("handles no open file", () => {
    expect(describeActivity({ userId: "u", openPath: null }, []).summary).toBe("Not viewing a file");
  });
});

describe("commitButtonView", () => {
  it("shows the count of ready files", () => {
    expect(commitButtonView(3, 2, false)).toMatchObject({ badge: 3, primary: true, aria: "Commit, 3 files ready" });
  });
  it("falls back to Push N, then quiet", () => {
    expect(commitButtonView(0, 2, false)).toMatchObject({ label: "Push 2", primary: true });
    expect(commitButtonView(0, 0, false)).toMatchObject({ primary: false, badge: null });
  });
  it("is busy while a job runs", () => {
    expect(commitButtonView(1, 0, true)).toMatchObject({ label: "Committing…", busy: true });
  });
});

it("baseName", () => expect(baseName("src/a/b.ts")).toBe("b.ts"));

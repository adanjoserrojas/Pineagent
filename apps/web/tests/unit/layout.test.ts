import { describe, expect, it } from "vitest";
import { activate, close, focusedActive, initialLayout, isImagePath, openIn, split } from "../../src/editor/layout";

describe("editor layout", () => {
  it("opens files as tabs in the focused group and re-activates an existing tab", () => {
    let l = openIn(initialLayout, "a.ts");
    l = openIn(l, "b.ts");
    expect(l.groups[0]).toEqual({ tabs: ["a.ts", "b.ts"], active: "b.ts" });
    l = openIn(l, "a.ts");
    expect(l.groups[0]).toEqual({ tabs: ["a.ts", "b.ts"], active: "a.ts" });
  });

  it("closing the active tab activates its neighbour, and the last tab leaves nothing active", () => {
    let l = openIn(openIn(openIn(initialLayout, "a"), "b"), "c");
    l = activate(l, 0, "b");
    l = close(l, 0, "b");
    expect(l.groups[0]).toEqual({ tabs: ["a", "c"], active: "c" });
    l = close(close(l, 0, "c"), 0, "a");
    expect(l.groups[0]).toEqual({ tabs: [], active: null });
  });

  it("a file open in one group is revealed there instead of opening in the other", () => {
    let l = openIn(initialLayout, "a");
    l = split(l);
    l = openIn(l, "b");
    expect(l.focused).toBe(1);
    l = openIn(l, "a");
    expect(l.focused).toBe(0);
    expect(l.groups.map((g) => g.tabs)).toEqual([["a"], ["b"]]);
  });

  it("closing the last tab of a group removes the split", () => {
    let l = split(openIn(initialLayout, "a"));
    l = openIn(l, "b");
    l = close(l, 1, "b");
    expect(l.groups).toHaveLength(1);
    expect(focusedActive(l)).toBe("a");
  });

  it("recognises image files by extension", () => {
    expect(["x.png", "dir/y.JPG", "z.svg", "q.avif"].every(isImagePath)).toBe(true);
    expect(["png", "a.ts", ".png", "dir.png/readme"].some(isImagePath)).toBe(false);
  });

  it("explicit Crown splits share the file and Explorer prefers its focused duplicate", () => {
    let l = split(openIn(initialLayout, "a.ts"), true);
    expect(l.groups.map((g) => g.active)).toEqual(["a.ts", "a.ts"]);
    l = openIn(l, "a.ts");
    expect(l.focused).toBe(1);
    expect(l.groups[1].tabs).toEqual(["a.ts"]);
    l = close(l, 1, "a.ts");
    expect(l.groups).toEqual([{ tabs: ["a.ts"], active: "a.ts" }]);
  });
});

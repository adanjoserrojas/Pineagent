import { describe, expect, it } from "vitest";
import { workspaceFromPath } from "../../src/routes";

describe("workspaceFromPath", () => {
  it("reads GitHub repositories, including branches with slashes", () => {
    expect(workspaceFromPath("/ws/adanjoserrojas/Pineagent/main", false)).toEqual({ wsId: "adanjoserrojas/Pineagent", branch: "main" });
    expect(workspaceFromPath("/ws/acme/demo/feat/login", false)).toEqual({ wsId: "acme/demo", branch: "feat/login" });
    expect(workspaceFromPath("/ws/acme/demo/feat%2Fx", false)).toEqual({ wsId: "acme/demo", branch: "feat/x" });
  });
  it("keeps the mock's one-word workspaces", () => {
    expect(workspaceFromPath("/ws/demo/main", true)).toEqual({ wsId: "demo", branch: "main" });
  });
  it("shows the picker for anything else in production, and the demo in dev", () => {
    expect(workspaceFromPath("/", false)).toBeNull();
    expect(workspaceFromPath("/ws/acme/demo/", false)).toBeNull();
    expect(workspaceFromPath("/", true)).toEqual({ wsId: "demo", branch: "main" });
  });
});

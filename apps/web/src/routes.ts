// URL shapes: /ws/<owner>/<repo>/<branch> for a GitHub repository (the branch may contain "/"),
// and /ws/<wsId>/<branch> for the mock's one-word workspaces. Anything else shows the repository
// picker (null), or in dev builds the mock's demo workspace.
export function workspaceFromPath(pathname: string, dev: boolean): { wsId: string; branch: string } | null {
  const parts = pathname.split("/").slice(1).map(decodeURIComponent);
  if (parts[0] !== "ws") return dev ? { wsId: "demo", branch: "main" } : null;
  const branch = parts.slice(3).join("/");
  if (parts.length >= 4 && branch) return { wsId: `${parts[1]}/${parts[2]}`, branch };
  if (parts.length === 3 && parts[2]) return { wsId: parts[1], branch: parts[2] };
  return null;
}

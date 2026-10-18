import type { Lock, Member } from "../contracts/socket";

// Auth0 `sub` for GitHub sign-ins is "github|<numeric id>"; the member's name is the login.
export function githubLogin(member: Pick<Member, "userId" | "name">): string | null {
  if (!member.userId.startsWith("github|")) return null;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(member.name) ? member.name : null;
}

export const githubUrl = (login: string) => `https://github.com/${login}`;

export type Activity = {
  summary: string;
  path: string | null; // the open file, for "Go to"
  otherLocks: string[]; // user-held locks besides the open file
  runLocks: string[]; // paths held by this person's agent runs
};

export function describeActivity(member: Pick<Member, "userId" | "openPath">, locks: Iterable<Lock>): Activity {
  const mine = [...locks].filter((l) => l.holder === member.userId);
  const userPaths = mine.filter((l) => l.holderType === "user").map((l) => l.path);
  const runLocks = mine.filter((l) => l.holderType === "run").map((l) => l.path);
  const open = member.openPath;
  const summary = !open ? "Not viewing a file" : userPaths.includes(open) ? `Editing ${open}` : `Viewing ${open}`;
  return { summary, path: open, otherLocks: userPaths.filter((p) => p !== open), runLocks };
}

export const baseName = (path: string) => path.replace(/\/$/, "").split("/").pop() ?? path;

export type CommitButtonView = { label: string; badge: number | null; primary: boolean; busy: boolean; aria: string };

export function commitButtonView(ready: number, ahead: number, busy: boolean): CommitButtonView {
  if (busy) return { label: "Committing…", badge: null, primary: false, busy: true, aria: "Commit, in progress" };
  if (ready > 0) {
    return { label: "Commit", badge: ready, primary: true, busy: false, aria: `Commit, ${ready} ${ready === 1 ? "file" : "files"} ready` };
  }
  if (ahead > 0) return { label: `Push ${ahead}`, badge: null, primary: true, busy: false, aria: `Push, ${ahead} ${ahead === 1 ? "commit" : "commits"} ahead` };
  return { label: "Commit", badge: null, primary: false, busy: false, aria: "Commit, nothing to commit" };
}

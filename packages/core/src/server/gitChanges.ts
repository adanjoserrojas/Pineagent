// Branch-wide working-tree status for the explorer's M/A/D letters (contracts/GIT_QUEUE.md,
// `git:changes`). Anything that can touch the worktree pokes it; one `git status` runs per burst
// and the room only hears about it when the set actually changed.
import type { FileChange } from "../contracts";
import type { GitRepo } from "./git";

export class ChangeFeed {
  private last = "[]";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly repo: GitRepo,
    private readonly emit: (changes: FileChange[]) => void,
    private readonly delayMs = 150,
  ) {}

  async current(): Promise<FileChange[]> {
    // Sorted, so the same set always compares equal (git lists tracked paths before untracked ones).
    return (await this.repo.status())
      .map(({ path, status }) => ({ path, status }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // The list for someone joining. When it isn't what the room last heard (the first join after a
  // start, with work already in the tree), the room hears it too, so the next change is compared
  // with what clients actually have.
  async forJoin(): Promise<FileChange[]> {
    const changes = await this.current();
    const key = JSON.stringify(changes);
    if (key !== this.last && !this.closed) {
      this.last = key;
      this.emit(changes);
    }
    return changes;
  }

  poke() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), this.delayMs);
  }

  private async refresh() {
    const changes = await this.current().catch(() => null);
    if (!changes || this.closed) return;
    const key = JSON.stringify(changes);
    if (key === this.last) return;
    this.last = key;
    this.emit(changes);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

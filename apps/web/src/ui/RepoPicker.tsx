import { useState, type FormEvent } from "react";
import { useSession } from "../auth/AuthGate";

// Repositories this deployment opens (the server's allowlist), shown as shortcuts.
const SUGGESTED: string[] = (import.meta.env.VITE_REPOS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// The page at "/": choose a GitHub repository and branch to open together.
export function RepoPicker() {
  const session = useSession();
  const [repo, setRepo] = useState(SUGGESTED[0] ?? "");
  const [branch, setBranch] = useState("main");
  const valid = REPO.test(repo.trim()) && branch.trim() !== "";

  function open(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const [owner, name] = repo.trim().split("/");
    const path = branch.trim().split("/").map(encodeURIComponent).join("/");
    window.location.assign(`/ws/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${path}`);
  }

  return (
    <main className="signin">
      <h1>Pineagent</h1>
      <p>Signed in as {session.displayName}. Open a repository you can push to; everyone on the same branch works together.</p>
      <form className="repo-picker" onSubmit={open}>
        <label>
          Repository
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" list="repo-suggestions" spellCheck={false} />
        </label>
        <datalist id="repo-suggestions">
          {SUGGESTED.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <label>
          Branch
          <input value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
        </label>
        <button type="submit" className="btn-primary" disabled={!valid}>
          Open
        </button>
      </form>
    </main>
  );
}

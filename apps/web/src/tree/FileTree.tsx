import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FileChange, Lock, Member, TreeCreateAck } from "../contracts/socket";
import { Avatar } from "../ui/Avatar";
import {
  allDirs,
  buildTree,
  changedDirs,
  coveringDirLock,
  fileTile,
  filterPaths,
  isLocked,
  lockOn,
  parentDir,
  visibleRows,
} from "./model";

type Props = {
  paths: string[];
  locks: ReadonlyMap<string, Lock>;
  changes: ReadonlyMap<string, FileChange["status"]>;
  members: Member[];
  selfId: string | null;
  openPath: string | null;
  loading: boolean;
  onOpen: (path: string) => void;
  // Asks the server to make a file or folder; null = no answer. Absent while offline.
  onCreate?: (path: string, kind: "file" | "dir") => Promise<TreeCreateAck | null>;
};

// The inline "new file/folder" row: `dir` is the folder it sits in ("" = repo root); `value` is the name typed so far.
type Draft = { id: number; kind: "file" | "dir"; dir: string; value: string; error: string | null };

const CREATE_ERROR = {
  INVALID: "That name can’t be used here.",
  LOCKED: "That folder is locked by someone else right now.",
  NONE: "The server didn’t answer. Try again.",
} as const;

type Mode = "all" | "changed" | "locked";
const MODE_LABEL: Record<Mode, string> = { all: "All", changed: "Changed", locked: "Locked" };
const CHANGE_LABEL: Record<FileChange["status"], string> = { M: "modified", A: "added", D: "deleted" };

// One focusable row. Filter, "Changed" and "Locked" modes show flat full paths; the default mode is the tree.
type Item = {
  path: string;
  kind: "file" | "dir";
  name: string;
  depth: number;
  prefix?: string; // dimmed directory part in flat modes
  match?: [number, number]; // highlighted range within `name`
};

const MAX_VIEWERS = 3;

export function FileTree({ paths, locks, changes, members, selfId, openPath, loading, onOpen, onCreate }: Props) {
  const roots = useMemo(() => buildTree(paths), [paths]);
  // `paths` also holds "dir/" entries for empty folders; filters and counts are about files.
  const files = useMemo(() => paths.filter((p) => !p.endsWith("/")), [paths]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const dirtyDirs = useMemo(() => changedDirs(changes.keys()), [changes]);
  // Folders start closed when a repository is opened; only the ones listed here are open.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const filterRef = useRef<HTMLInputElement>(null);
  const moveFocus = useRef(false);
  const nextDraftId = useRef(0);
  // Set once the draft row is submitted or cancelled, so the blur that follows doesn't act on it again.
  const draftSettled = useRef(false);
  const reveal = useRef<string | null>(null);

  const items: Item[] = useMemo(() => {
    if (query.trim()) {
      return filterPaths(files, query).map(({ path, start, end }) => flatItem(path, "file", [start, end]));
    }
    if (mode === "changed") {
      // Deleted files aren't in the tree, so this list comes from Git, not from `paths`.
      return [...changes.keys()].sort().map((p) => flatItem(p, "file"));
    }
    if (mode === "locked") {
      const lockedFiles = files.filter((p) => isLocked(p, locks));
      const lockedDirs = [...locks.values()].filter((l) => l.kind === "dir").map((l) => l.path);
      return [...lockedDirs, ...lockedFiles].sort().map((p) => flatItem(p, p.endsWith("/") ? "dir" : "file"));
    }
    return visibleRows(roots, expanded).map(({ node, depth }) => ({
      path: node.path,
      kind: node.kind,
      name: node.name,
      depth,
    }));
  }, [files, roots, locks, changes, expanded, query, mode]);

  const focused = items.some((i) => i.path === focusPath) ? focusPath : (items[0]?.path ?? null);

  useEffect(() => {
    // Wait for the row itself: a just-created path arrives with the room's tree:changed.
    if (!moveFocus.current || !focused || focused !== focusPath) return;
    moveFocus.current = false;
    rowRefs.current.get(focused)?.focus();
  }, [focused, focusPath]);

  // Whatever opens a file (a click, the filter, a teammate's file, a new file) should show its row.
  useEffect(() => {
    if (!openPath) return;
    reveal.current = openPath;
    setExpanded((prev) => withAncestors(prev, openPath));
  }, [openPath]);

  useEffect(() => {
    // The row may not exist yet (a just-created file arrives with tree:changed), so wait for it.
    const row = reveal.current && rowRefs.current.get(reveal.current);
    if (!row) return;
    reveal.current = null;
    row.scrollIntoView({ block: "nearest" });
  }, [items]);

  const viewersOf = (path: string) => members.filter((m) => m.userId !== selfId && m.openPath === path);
  const counts: Record<Mode, number | null> = {
    all: null,
    changed: changes.size,
    locked: files.filter((p) => isLocked(p, locks)).length,
  };
  const inTree = !query.trim() && mode === "all";

  function toggle(dir: string, open?: boolean) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !prev.has(dir)) next.add(dir);
      else next.delete(dir);
      return next;
    });
  }

  // New things go in the folder you last picked: that folder itself, or the one holding that file.
  function startCreate(kind: Draft["kind"]) {
    const picked = focusPath ?? openPath;
    const dir = !picked ? "" : picked.endsWith("/") ? picked : (parentDir(picked) ?? "");
    setQuery("");
    setMode("all");
    if (dir) setExpanded((prev) => withAncestors(prev, dir, true));
    draftSettled.current = false;
    setDraft({ id: nextDraftId.current++, kind, dir, value: "", error: null });
  }

  function cancelDraft(refocus: boolean) {
    if (!draft) return;
    draftSettled.current = true;
    setDraft(null);
    if (refocus) focusItem(draft.dir || items[0]?.path);
  }

  // `fromBlur`: the box lost focus, so the focus must not be dragged back to the tree afterwards.
  async function submitDraft(fromBlur = false) {
    if (!draft || draftSettled.current || !onCreate) return;
    const name = draft.value.trim();
    const { id, kind, dir } = draft;
    const fail = (error: string) => setDraft((d) => (d?.id === id ? { ...d, error } : d));
    if (!name || (kind === "file" && name.endsWith("/"))) {
      return fail(kind === "file" ? "Type a file name, like notes.md." : "Type a folder name.");
    }
    const path = dir + (kind === "dir" ? name.replace(/\/+$/, "") : name);
    draftSettled.current = true;
    const res = await onCreate(path, kind);
    if (!res || !res.ok) {
      draftSettled.current = false;
      return fail(
        res ? (res.code === "EXISTS" ? `A file or folder named “${name.replace(/\/+$/, "")}” already exists here.` : CREATE_ERROR[res.code]) : CREATE_ERROR.NONE,
      );
    }
    setDraft((d) => (d?.id === id ? null : d));
    // Show where it landed: open every folder on the way down.
    setExpanded((prev) => withAncestors(prev, res.path, kind === "dir"));
    // A new file opens in the editor, so leave keyboard focus alone; a new folder gets the focus.
    if (kind === "file") {
      setFocusPath(res.path);
      onOpen(res.path);
    } else if (fromBlur) {
      setFocusPath(res.path);
    } else {
      focusItem(res.path);
    }
  }

  function focusItem(path: string | undefined) {
    if (!path) return;
    moveFocus.current = true;
    setFocusPath(path);
  }

  function activate(item: Item) {
    setFocusPath(item.path);
    if (item.kind === "file") onOpen(item.path);
    else if (inTree) toggle(item.path);
    else {
      setQuery("");
      setMode("all");
      toggle(item.path, true);
    }
  }

  function onTreeKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    const index = items.findIndex((i) => i.path === focused);
    const item = items[index];
    if (!item) return;
    const isOpen = item.kind === "dir" && inTree && expanded.has(item.path);
    switch (e.key) {
      case "ArrowDown":
        focusItem(items[Math.min(index + 1, items.length - 1)].path);
        break;
      case "ArrowUp":
        focusItem(items[Math.max(index - 1, 0)].path);
        break;
      case "Home":
        focusItem(items[0].path);
        break;
      case "End":
        focusItem(items[items.length - 1].path);
        break;
      case "ArrowRight":
        if (item.kind !== "dir" || !inTree) return;
        if (isOpen) focusItem(items[index + 1]?.path);
        else toggle(item.path, true);
        break;
      case "ArrowLeft":
        if (!inTree) return;
        if (isOpen) toggle(item.path, false);
        else focusItem(parentDir(item.path) ?? undefined);
        break;
      case "Enter":
      case " ":
        activate(item);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function onExplorerKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "/" && e.target !== filterRef.current) {
      e.preventDefault();
      filterRef.current?.focus();
    }
  }

  return (
    <div className="explorer" onKeyDown={onExplorerKeyDown}>
      <div className="explorer-head">
        <h2 className="section-label">Explorer</h2>
        <button type="button" className="icon-btn" aria-label="New file" title="New file" disabled={!onCreate} onClick={() => startCreate("file")}>
          <NewFileIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="New folder" title="New folder" disabled={!onCreate} onClick={() => startCreate("dir")}>
          <NewFolderIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Expand all folders" onClick={() => setExpanded(new Set(allDirs(roots)))}>
          <Chevrons up={false} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Collapse all folders"
          onClick={() => setExpanded(new Set())}
        >
          <Chevrons up />
        </button>
      </div>

      <label className="explorer-filter">
        <SearchIcon />
        <span className="sr-only">Filter files</span>
        <input
          ref={filterRef}
          type="search"
          placeholder="Filter files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "ArrowDown") focusItem(items[0]?.path);
            if (e.key === "Enter" && items[0]?.kind === "file") onOpen(items[0].path);
          }}
        />
        {query.trim() ? (
          <span className="explorer-count" aria-live="polite">
            {items.length} {items.length === 1 ? "match" : "matches"}
          </span>
        ) : (
          <kbd>/</kbd>
        )}
      </label>

      <div className="explorer-modes" role="radiogroup" aria-label="Show">
        {(["all", "changed", "locked"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className="mode-btn"
            onClick={() => setMode(m)}
          >
            {counts[m] === null ? MODE_LABEL[m] : `${MODE_LABEL[m]} · ${counts[m]}`}
          </button>
        ))}
      </div>

      {loading && paths.length === 0 ? (
        <p className="explorer-note" aria-busy="true">
          Loading files…
        </p>
      ) : items.length === 0 && !(draft && inTree) ? (
        <p className="explorer-note">
          {query.trim()
            ? "No files match."
            : mode === "locked"
              ? "Nothing is locked."
              : mode === "changed"
                ? "No uncommitted changes on this branch."
                : "No files yet."}
        </p>
      ) : (
        <ul role="tree" aria-label="Files" className="tree-list" onKeyDown={onTreeKeyDown}>
          {draft && inTree && draft.dir === "" && createRow(draft)}
          {items.map((item) => {
            const lock = lockOn(item.path, locks);
            const inherited = !lock && item.kind === "file" ? coveringDirLock(item.path, locks) : undefined;
            // The lock badge already shows its holder's face, so don't repeat them as a viewer.
            const badgeFace = lock && lock.holderType === "user" ? lock.holder : null;
            const viewers = item.kind === "file" ? viewersOf(item.path).filter((v) => v.userId !== badgeFace) : [];
            const tile = fileTile(item.name);
            const isDirOpen = item.kind === "dir" && inTree && expanded.has(item.path);
            const change = item.kind === "file" ? changes.get(item.path) : undefined;
            const row = (
              <li
                key={item.path}
                ref={(el) => {
                  if (el) rowRefs.current.set(item.path, el);
                  else rowRefs.current.delete(item.path);
                }}
                role="treeitem"
                aria-level={item.depth + 1}
                aria-expanded={item.kind === "dir" && inTree ? isDirOpen : undefined}
                aria-selected={item.path === openPath}
                tabIndex={item.path === focused ? 0 : -1}
                className="tree-row"
                data-path={item.path}
                style={{ paddingLeft: 10 + item.depth * 16 }}
                title={item.path}
                onClick={() => activate(item)}
              >
                {item.kind === "dir" ? (
                  <>
                    <svg className={isDirOpen || !inTree ? "chev" : "chev chev-closed"} width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    <FolderIcon held={Boolean(lock)} />
                  </>
                ) : (
                  <span className={`tile tile-${tile.tone}`} aria-hidden="true">
                    {tile.label}
                  </span>
                )}
                <span className={change ? `row-name mono git-name-${change}` : "row-name mono"}>
                  {item.prefix && <span className="row-prefix">{item.prefix}</span>}
                  {item.match ? (
                    <>
                      {item.name.slice(0, item.match[0])}
                      <mark>{item.name.slice(item.match[0], item.match[1])}</mark>
                      {item.name.slice(item.match[1])}
                    </>
                  ) : (
                    item.name.replace(/\/$/, "")
                  )}
                </span>
                {viewers.length > 0 && (
                  <span className="row-viewers">
                    {viewers.slice(0, MAX_VIEWERS).map((v) => (
                      <Avatar key={v.userId} name={v.name} url={v.avatarUrl} size={18} label={`${v.name} has this open`} />
                    ))}
                    {viewers.length > MAX_VIEWERS && <span className="viewers-more">+{viewers.length - MAX_VIEWERS}</span>}
                  </span>
                )}
                {(lock ?? inherited) && (
                  <LockBadge lock={(lock ?? inherited)!} inherited={!lock} members={members} selfId={selfId} />
                )}
                {change ? (
                  <span className={`git-letter git-${change}`} title={`Uncommitted: ${CHANGE_LABEL[change]}`} data-testid="git-status">
                    <span aria-hidden="true">{change}</span>
                    <span className="sr-only">{CHANGE_LABEL[change]}</span>
                  </span>
                ) : (
                  item.kind === "dir" &&
                  dirtyDirs.has(item.path) && (
                    <span className="git-dot" title="Contains uncommitted changes" data-testid="git-status">
                      <span className="sr-only">contains changes</span>
                    </span>
                  )
                )}
              </li>
            );
            return draft && inTree && draft.dir === item.path ? [row, createRow(draft)] : row;
          })}
        </ul>
      )}
    </div>
  );

  // The inline name box, shown as the first child of its folder (like VS Code).
  function createRow(d: Draft) {
    const depth = d.dir.split("/").length - 1;
    const label = d.kind === "dir" ? "New folder name" : "New file name";
    return (
      <li
        key="new"
        role="presentation"
        className="tree-create"
        style={{ paddingLeft: 10 + depth * 16 }}
        // Typing a name must not trigger tree navigation or the "/" filter shortcut.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="create-line">
          {d.kind === "dir" ? <FolderIcon held={false} /> : <PlainFileIcon />}
          <div className="create-field">
            <input
              autoFocus
              className="create-input mono"
              aria-label={label}
              aria-invalid={Boolean(d.error)}
              aria-describedby={d.error ? "explorer-create-error" : undefined}
              value={d.value}
              spellCheck={false}
              onChange={(e) => setDraft({ ...d, value: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitDraft();
                } else if (e.key === "Escape") cancelDraft(true);
              }}
              // Like VS Code: leaving an empty box (or one already refused) cancels, leaving text creates.
              onBlur={() => (d.value.trim() && !d.error ? void submitDraft(true) : cancelDraft(false))}
            />
            {d.error && (
              <p id="explorer-create-error" className="create-error" role="alert">
                {d.error}
              </p>
            )}
          </div>
        </div>
      </li>
    );
  }

  function flatItem(path: string, kind: Item["kind"], match?: [number, number]): Item {
    const trimmed = path.replace(/\/$/, "");
    const cut = trimmed.lastIndexOf("/") + 1;
    // Filter matches index into the full path; re-base them onto the name, clamping into the prefix.
    const rebased: [number, number] | undefined = match && [Math.max(match[0] - cut, 0), Math.max(match[1] - cut, 0)];
    return {
      path,
      kind,
      name: path.slice(cut),
      depth: 0,
      prefix: path.slice(0, cut),
      match: rebased && rebased[1] > rebased[0] ? rebased : undefined,
    };
  }
}

// `self` also opens the path's own folder (for a folder that was just made).
function withAncestors(prev: ReadonlySet<string>, path: string, self = false): ReadonlySet<string> {
  const next = new Set(prev);
  for (let d = self && path.endsWith("/") ? path : parentDir(path); d; d = parentDir(d)) next.add(d);
  return next.size === prev.size ? prev : next;
}

function LockBadge({
  lock,
  inherited,
  members,
  selfId,
}: {
  lock: Lock;
  inherited: boolean;
  members: Member[];
  selfId: string | null;
}) {
  const holder = members.find((m) => m.userId === lock.holder);
  const name = holder?.name ?? lock.holder.replace(/^.*\|/, "");
  const mine = lock.holder === selfId;
  const isRun = lock.holderType === "run";
  const who = isRun ? (mine ? "Your agent" : `${name}’s agent`) : mine ? "You" : name;
  const tone = isRun ? "agent" : mine ? "self" : "other";
  const label = inherited ? `in ${mine && !isRun ? "your" : `${who}’s`} folder` : lock.kind === "dir" ? `${who} · folder` : who;
  return (
    <span className={`lock-badge lock-${tone}${inherited ? " lock-inherited" : ""}`} data-testid="lock-badge">
      <span className="sr-only">Locked by </span>
      {isRun ? (
        <BotIcon />
      ) : (
        !inherited && <Avatar name={name} url={holder?.avatarUrl ?? null} size={16} label={`${name}’s avatar`} />
      )}
      {label}
    </span>
  );
}

function NewFileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 12v6M9 15h6" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

function FolderIcon({ held }: { held: boolean }) {
  return (
    <svg className={held ? "folder folder-held" : "folder"} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function PlainFileIcon() {
  return (
    <svg className="folder" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    </svg>
  );
}

function BotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4" />
      <circle cx="9.5" cy="13.5" r="1" />
      <circle cx="14.5" cy="13.5" r="1" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </svg>
  );
}

function Chevrons({ up }: { up: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      {up ? <path d="M7 10l5-5 5 5M7 19l5-5 5 5" /> : <path d="M7 5l5 5 5-5M7 14l5 5 5-5" />}
    </svg>
  );
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Lock, Member } from "../contracts/socket";
import { Avatar } from "../ui/Avatar";
import {
  allDirs,
  buildTree,
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
  members: Member[];
  selfId: string | null;
  openPath: string | null;
  loading: boolean;
  onOpen: (path: string) => void;
};

type Mode = "all" | "locked";

// One focusable row. Filter and "Locked" modes show flat full paths; the default mode is the tree.
type Item = {
  path: string;
  kind: "file" | "dir";
  name: string;
  depth: number;
  prefix?: string; // dimmed directory part in flat modes
  match?: [number, number]; // highlighted range within `name`
};

const MAX_VIEWERS = 3;

export function FileTree({ paths, locks, members, selfId, openPath, loading, onOpen }: Props) {
  const roots = useMemo(() => buildTree(paths), [paths]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const filterRef = useRef<HTMLInputElement>(null);
  const moveFocus = useRef(false);

  const items: Item[] = useMemo(() => {
    if (query.trim()) {
      return filterPaths(paths, query).map(({ path, start, end }) => flatItem(path, "file", [start, end]));
    }
    if (mode === "locked") {
      const lockedFiles = paths.filter((p) => isLocked(p, locks));
      const lockedDirs = [...locks.values()].filter((l) => l.kind === "dir").map((l) => l.path);
      return [...lockedDirs, ...lockedFiles].sort().map((p) => flatItem(p, p.endsWith("/") ? "dir" : "file"));
    }
    const expanded = new Set(allDirs(roots).filter((d) => !collapsed.has(d)));
    return visibleRows(roots, expanded).map(({ node, depth }) => ({
      path: node.path,
      kind: node.kind,
      name: node.name,
      depth,
    }));
  }, [paths, roots, locks, collapsed, query, mode]);

  const focused = items.some((i) => i.path === focusPath) ? focusPath : (items[0]?.path ?? null);

  useEffect(() => {
    if (!moveFocus.current || !focused) return;
    moveFocus.current = false;
    rowRefs.current.get(focused)?.focus();
  }, [focused]);

  const viewersOf = (path: string) => members.filter((m) => m.userId !== selfId && m.openPath === path);
  const lockedCount = paths.filter((p) => isLocked(p, locks)).length;
  const inTree = !query.trim() && mode === "all";

  function toggle(dir: string, open?: boolean) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const isOpen = !prev.has(dir);
      if (open ?? !isOpen) next.delete(dir);
      else next.add(dir);
      return next;
    });
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
    const expanded = item.kind === "dir" && inTree && !collapsed.has(item.path);
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
        if (expanded) focusItem(items[index + 1]?.path);
        else toggle(item.path, true);
        break;
      case "ArrowLeft":
        if (!inTree) return;
        if (expanded) toggle(item.path, false);
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
        <button type="button" className="icon-btn" aria-label="Expand all folders" onClick={() => setCollapsed(new Set())}>
          <Chevrons up={false} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Collapse all folders"
          onClick={() => setCollapsed(new Set(allDirs(roots)))}
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
        {(["all", "locked"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className="mode-btn"
            onClick={() => setMode(m)}
          >
            {m === "all" ? "All" : `Locked · ${lockedCount}`}
          </button>
        ))}
      </div>

      {loading && paths.length === 0 ? (
        <p className="explorer-note" aria-busy="true">
          Loading files…
        </p>
      ) : items.length === 0 ? (
        <p className="explorer-note">{query.trim() ? "No files match." : mode === "locked" ? "Nothing is locked." : "No files yet."}</p>
      ) : (
        <ul role="tree" aria-label="Files" className="tree-list" onKeyDown={onTreeKeyDown}>
          {items.map((item) => {
            const lock = lockOn(item.path, locks);
            const inherited = !lock && item.kind === "file" ? coveringDirLock(item.path, locks) : undefined;
            const viewers = item.kind === "file" ? viewersOf(item.path) : [];
            const tile = fileTile(item.name);
            const isDirOpen = item.kind === "dir" && inTree && !collapsed.has(item.path);
            return (
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
                <span className="row-name mono">
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

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

function FolderIcon({ held }: { held: boolean }) {
  return (
    <svg className={held ? "folder folder-held" : "folder"} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
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

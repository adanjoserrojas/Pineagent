import { useEffect, useId, useRef, useState } from "react";
import type { Lock, Member } from "../contracts/socket";
import { Avatar } from "./Avatar";
import { baseName, describeActivity, githubLogin, githubUrl } from "./profile";

// An avatar in the top bar that opens a small card about that person.
export function MemberChip({
  member,
  isSelf,
  locks,
  onOpenFile,
}: {
  member: Member;
  isSelf: boolean;
  locks: Map<string, Lock>;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = isSelf ? `You (${member.name})` : member.name;

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="member-chip" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="member-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}, show profile`}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={member.name} url={member.avatarUrl} tone={isSelf ? "self" : "other"} label={label} />
      </button>
      {open && (
        <ProfileCard
          member={member}
          isSelf={isSelf}
          locks={locks}
          onOpenFile={(path) => {
            onOpenFile(path);
            close(false);
          }}
        />
      )}
    </span>
  );
}

function ProfileCard({
  member,
  isSelf,
  locks,
  onOpenFile,
}: {
  member: Member;
  isSelf: boolean;
  locks: Map<string, Lock>;
  onOpenFile: (path: string) => void;
}) {
  const titleId = useId();
  const card = useRef<HTMLDivElement>(null);
  const login = githubLogin(member);
  const activity = describeActivity(member, locks.values());

  useEffect(() => card.current?.focus(), []);

  return (
    <div className="profile-card" role="dialog" aria-labelledby={titleId} tabIndex={-1} ref={card}>
      <div className="profile-head">
        <Avatar name={member.name} url={member.avatarUrl} size={48} tone={isSelf ? "self" : "other"} />
        <div className="profile-id">
          <h2 id={titleId} className="profile-name">
            {member.name}
            {isSelf && <span className="profile-you"> (you)</span>}
          </h2>
          {login && (
            <a href={githubUrl(login)} target="_blank" rel="noopener noreferrer" className="profile-link">
              @{login}
            </a>
          )}
        </div>
      </div>
      <p className="profile-activity">{activity.summary}</p>
      {activity.otherLocks.length > 0 && <PathList title="Also editing" paths={activity.otherLocks} />}
      {activity.runLocks.length > 0 && <PathList title="Agent run holds" paths={activity.runLocks} />}
      {!isSelf && activity.path && (
        <button type="button" className="btn-primary profile-go" onClick={() => onOpenFile(activity.path!)}>
          Go to {baseName(activity.path)}
        </button>
      )}
    </div>
  );
}

function PathList({ title, paths }: { title: string; paths: string[] }) {
  return (
    <div className="profile-locks">
      <span className="profile-locks-title">{title}</span>
      <ul>
        {paths.map((p) => (
          <li key={p} className="mono" title={p}>
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useState } from "react";

export type AvatarTone = "self" | "other" | "none";

// GitHub profile picture with an initials fallback when the image is missing or fails to load.
export function Avatar({
  name,
  url,
  size = 28,
  tone = "none",
  label,
}: {
  name: string;
  url: string | null;
  size?: number;
  tone?: AvatarTone;
  label?: string;
}) {
  const [failed, setFailed] = useState(false);
  const accessible = label ?? name;
  return (
    <span
      className={`avatar avatar-${tone}`}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
      title={accessible}
    >
      {url && !failed ? (
        <img
          src={url}
          alt={accessible}
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span role="img" aria-label={accessible}>
          {initials(name)}
        </span>
      )}
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

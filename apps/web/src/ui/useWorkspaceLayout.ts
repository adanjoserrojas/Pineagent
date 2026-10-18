import { useEffect, useState } from "react";

const KEY = "pineagent:crown-layout:v1";
export const defaultLayout = { explorer: 244, agents: 332, activity: 150, filesVisible: true, agentsVisible: true, activityVisible: true };
export function useWorkspaceLayout() {
  const [layout, setLayout] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      const next = { ...defaultLayout };
      for (const key of ["explorer", "agents", "activity"] as const) {
        if (typeof saved[key] === "number" && Number.isFinite(saved[key])) next[key] = Math.max(key === "activity" ? 90 : 190, Math.min(key === "activity" ? 360 : 520, saved[key]));
      }
      for (const key of ["filesVisible", "agentsVisible", "activityVisible"] as const) if (typeof saved[key] === "boolean") next[key] = saved[key];
      return next;
    } catch { return defaultLayout; }
  });
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* Private/full storage must not break the workspace. */ } }, [layout]);
  return [layout, setLayout] as const;
}

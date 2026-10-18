// Which files are open in which editor group. Pure functions so the rules are unit-testable.
// A file is open in at most one group: its FileSession has a single Monaco binding, so showing
// it twice would need shared models. Opening a file that is already open just reveals its tab.

export type Group = { tabs: string[]; active: string | null };
export type Layout = { groups: Group[]; focused: number };

export const initialLayout: Layout = { groups: [{ tabs: [], active: null }], focused: 0 };

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
export const isImagePath = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXT.has(name.slice(dot + 1).toLowerCase());
};

export const focusedActive = (l: Layout): string | null => l.groups[l.focused]?.active ?? null;

export function openIn(l: Layout, path: string): Layout {
  const at = l.groups.findIndex((g) => g.tabs.includes(path));
  if (at >= 0) return activate(l, at, path);
  const groups = l.groups.map((g, i) => (i === l.focused ? { tabs: [...g.tabs, path], active: path } : g));
  return { ...l, groups };
}

export function activate(l: Layout, group: number, path: string): Layout {
  const groups = l.groups.map((g, i) => (i === group ? { ...g, active: path } : g));
  return { groups, focused: group };
}

export function focus(l: Layout, group: number): Layout {
  return l.focused === group || !l.groups[group] ? l : { ...l, focused: group };
}

export function close(l: Layout, group: number, path: string): Layout {
  const g = l.groups[group];
  const at = g?.tabs.indexOf(path) ?? -1;
  if (!g || at < 0) return l;
  const tabs = g.tabs.filter((t) => t !== path);
  // The neighbour that slides into the closed tab's place, else the one before it.
  const active = g.active === path ? (tabs[at] ?? tabs[at - 1] ?? null) : g.active;
  if (tabs.length === 0 && l.groups.length > 1) {
    return { groups: l.groups.filter((_, i) => i !== group), focused: 0 };
  }
  return { ...l, groups: l.groups.map((x, i) => (i === group ? { tabs, active } : x)) };
}

export function split(l: Layout): Layout {
  if (l.groups.length > 1) return l;
  return { groups: [...l.groups, { tabs: [], active: null }], focused: 1 };
}

export const activePaths = (l: Layout): string[] => l.groups.flatMap((g) => (g.active ? [g.active] : []));

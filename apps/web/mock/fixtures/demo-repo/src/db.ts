const rows = new Map<string, unknown>();

export function get(id: string) {
  return rows.get(id);
}

export function put(id: string, value: unknown) {
  rows.set(id, value);
}

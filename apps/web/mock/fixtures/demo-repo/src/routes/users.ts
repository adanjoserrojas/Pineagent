import { get } from "../db";

export function users(id: string) {
  return get(id) ?? null;
}

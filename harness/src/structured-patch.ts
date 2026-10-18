import { createHash } from "node:crypto";
import type { FileSnapshot } from "./types.js";

export const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Materialize bounded exact edits locally. New files use complete content;
 * existing files can use hash-bound anchors instead of repeating unchanged text. */
export function materializePatch(value: unknown, allowedWrites: readonly string[], bases: readonly FileSnapshot[] = []): FileSnapshot[] {
  if (!object(value)) throw new Error("Invalid structured patch");
  const files = value.files ?? [], edits = value.edits ?? [];
  if (!Array.isArray(files) || !Array.isArray(edits) || files.length + edits.length < 1 || files.length + edits.length > 12) throw new Error("Invalid structured patch");
  const result: FileSnapshot[] = [], seen = new Set<string>();
  const add = (path: unknown, content: unknown) => {
    if (typeof path !== "string" || !allowedWrites.includes(path) || seen.has(path) || typeof content !== "string"
      || content.includes("\0") || Buffer.byteLength(content) > 1_000_000) throw new Error("Invalid structured patch file");
    seen.add(path); result.push({ path, content });
  };
  for (const file of files) { if (!object(file)) throw new Error("Invalid patch file"); add(file.path, file.content); }
  for (const edit of edits) {
    if (!object(edit) || typeof edit.path !== "string" || !Array.isArray(edit.changes) || !edit.changes.length || edit.changes.length > 32) throw new Error("Invalid patch edit");
    const base = bases.find(file => file.path === edit.path);
    if (!base || edit.baseSha256 !== contentHash(base.content)) throw new Error("Patch base hash mismatch");
    let content = base.content;
    for (const change of edit.changes) {
      if (!object(change) || typeof change.before !== "string" || !change.before || typeof change.after !== "string") throw new Error("Invalid patch anchor");
      const index = content.indexOf(change.before);
      if (index < 0 || content.indexOf(change.before, index + 1) >= 0) throw new Error("Patch anchor missing or ambiguous");
      content = content.slice(0, index) + change.after + content.slice(index + change.before.length);
      if (Buffer.byteLength(content) > 1_000_000) throw new Error("Patch exceeds file budget");
    }
    add(edit.path, content);
  }
  return result;
}

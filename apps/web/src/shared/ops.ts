import type { Op } from "../contracts/socket";

// Shared by the browser and the server so both sides apply edits identically.
// Ops in one batch apply in array order, each against the text left by the previous one.

export function isValidOp(op: unknown): op is Op {
  if (typeof op !== "object" || op === null) return false;
  const { offset, length, text } = op as Record<string, unknown>;
  return (
    Number.isInteger(offset) && (offset as number) >= 0 &&
    Number.isInteger(length) && (length as number) >= 0 &&
    typeof text === "string"
  );
}

// Returns null when an op points outside the text, so callers can reject the whole batch.
export function applyOps(text: string, ops: readonly Op[]): string | null {
  let out = text;
  for (const op of ops) {
    if (!isValidOp(op) || op.offset + op.length > out.length) return null;
    out = out.slice(0, op.offset) + op.text + out.slice(op.offset + op.length);
  }
  return out;
}

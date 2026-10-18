import { describe, expect, it } from "vitest";
import { OpusRun, OPUS_MODEL, type ModelTransport } from "../src/models/bedrock";
import { contentHash } from "@pineagent/harness";

describe("bounded Opus model gateway", () => {
  it("enforces a cumulative input budget before another provider request", async () => {
    let calls = 0;
    const run = new OpusRun({ runId: "budget", ownerId: "alice", maxCalls: 8, maxInputChars: 5000, transport: async () => {
      calls++;
      return { $metadata: {}, stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"files":[{"path":"app.py","content":"value = 1"}]}' } } };
        yield { messageStop: { stopReason: "end_turn" } };
      })() };
    } });
    const input = { task: "feature", evidence: "x".repeat(3000), allowedWrites: ["app.py"] };
    await run.patch(input);
    await expect(run.patch(input)).rejects.toThrow("input budget");
    expect(calls).toBe(1);
  });
  it("materializes a hash-bound feature edit without sending duplicate base contents", async () => {
    const content = "export const value = 1;";
    const run = new OpusRun({ runId: "edit", ownerId: "alice", transport: async input => {
      const prompt = JSON.parse(input.messages![0].content![0].text!);
      expect(prompt.bases).toBeUndefined();
      expect(prompt.baseHashes["app.mjs"]).toBe(contentHash(content));
      return { $metadata: {}, stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: JSON.stringify({ edits: [{ path: "app.mjs",
          baseSha256: contentHash(content), changes: [{ before: "value = 1", after: "value = 2" }] }] }) } } };
        yield { messageStop: { stopReason: "end_turn" } };
      })() };
    } });
    const patch = await run.patch({ task: "change value", evidence: content, allowedWrites: ["app.mjs"], bases: [{ path: "app.mjs", content }] });
    expect(patch.files).toEqual([{ path: "app.mjs", content: "export const value = 2;" }]);
    expect(run.receipts()).toHaveLength(1);
  });
  it("uses Opus 4.6 adaptive thinking and returns validated patch text with usage", async () => {
    const transport: ModelTransport = async (input) => {
      expect(input.modelId).toBe(OPUS_MODEL);
      expect(input.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
      return { $metadata: { requestId: "aws-test" }, stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "not returned" } } } };
        yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text: '{"files":[{"path":"src/sum.js","content":"export const sum = (a,b) => a+b;"}]}' } } };
        yield { messageStop: { stopReason: "end_turn" } };
        yield { metadata: { usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 }, metrics: { latencyMs: 5 } } };
      })() };
    };
    const run = new OpusRun({ runId: "r1", ownerId: "alice", transport, maxCalls: 3 });
    const result = await run.patch({ task: "implement sum", evidence: "test", allowedWrites: ["src/sum.js"] });
    expect(result.files).toHaveLength(1);
    expect(result.usage).toMatchObject({ inputTokens: 50, outputTokens: 20 });
    expect(run.receipts()).toMatchObject([{ requestId: "aws-test", status: "ok", purpose: "patch" }]);
  });
  it("rejects an out-of-scope patch and counts the failed attempt against the budget", async () => {
    const run = new OpusRun({ runId: "r", ownerId: "alice", maxCalls: 1, transport: async () => ({
      $metadata: {}, stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"files":[{"path":"secret.js","content":"x"}]}' } } };
        yield { messageStop: { stopReason: "end_turn" } };
      })(),
    }) });
    await expect(run.patch({ task: "repair", evidence: "", allowedWrites: ["src/a.js"] })).rejects.toThrow("no patch authorized");
    await expect(run.patch({ task: "repair", evidence: "", allowedWrites: ["src/a.js"] })).rejects.toThrow("budget");
    expect(run.receipts()).toHaveLength(1);
    expect(run.receipts()[0].status).toBe("failed");
    expect(run.receipts()[0].usage.inputTokens).toBeNull();
  });

  it("does not turn provider errors or truncated output into patches", async () => {
    const run = new OpusRun({ runId: "r", ownerId: "alice", transport: async () => ({
      $metadata: {}, stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"files":[]}' } } };
        yield { messageStop: { stopReason: "max_tokens" } };
      })(),
    }) });
    await expect(run.patch({ task: "repair", evidence: "", allowedWrites: ["src/a.js"] })).rejects.toThrow("no patch authorized");
    expect(run.receipts()[0].status).toBe("failed");
  });

  it("times out even when a transport never returns, without automatic retries", async () => {
    let attempts = 0;
    const run = new OpusRun({ runId: "r", ownerId: "alice", timeoutMs: 10, transport: async () => {
      attempts++;
      return new Promise(() => {});
    } });
    await expect(run.patch({ task: "repair", evidence: "", allowedWrites: ["src/a.js"] })).rejects.toThrow("timed out");
    expect(attempts).toBe(1);
    expect(run.receipts()[0].status).toBe("failed");
  });

  it("will not plan to modify the verification file", async () => {
    const run = new OpusRun({ runId: "r", ownerId: "alice", transport: async () => ({
      $metadata: {}, stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"allowedWrites":["test/a.js"],"visibleTestPath":"test/a.js"}' } } };
        yield { messageStop: { stopReason: "end_turn" } };
      })(),
    }) });
    await expect(run.plan("repair", ["src/a.js", "test/a.js"])).rejects.toThrow("no patch authorized");
    expect(run.receipts()[0].status).toBe("failed");
  });
});

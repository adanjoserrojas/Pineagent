import { describe, expect, it } from "vitest";
import { OpusRun, OPUS_MODEL, type ModelTransport } from "../src/models/bedrock";

describe("bounded Opus model gateway", () => {
  it("reports malformed patch output distinctly without exposing provider text", async () => {
    const run = new OpusRun({ runId: "r", ownerId: "alice", transport: async () => ({
      $metadata: { requestId: "format-failure" }, stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "not-json PRIVATE_PROVIDER_TEXT" } } };
        yield { messageStop: { stopReason: "end_turn" } };
      })(),
    }) });
    await expect(run.patch({ task: "repair", evidence: "", allowedWrites: ["app.py"] }))
      .rejects.toMatchObject({ code: "MODEL_INVALID_JSON" });
    expect(run.receipts()).toMatchObject([{ failureCode: "MODEL_INVALID_JSON", stopReason: "end_turn" }]);
    expect(JSON.stringify(run.receipts())).not.toContain("PRIVATE_PROVIDER_TEXT");
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

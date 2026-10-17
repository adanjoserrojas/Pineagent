import test from "node:test";
import assert from "node:assert/strict";
import { createFrozenSynthesize } from "../src/frozen-config.js";

test("frozen synthesis factory pins the V8 worker's model, medium effort and patch contract", async () => {
  let calls = 0;
  const synthesize = createFrozenSynthesize({ apiKey: "fake", fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(options.body));
    assert.equal(body.model, "gpt-6-sol");
    assert.deepEqual(body.reasoning, { effort: "medium" });
    assert.equal(body.max_output_tokens, 8192);
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].role, "user");
    assert.match(body.input[0].content[0].text, /Do not change tests/);
    assert.match(body.input[0].content[0].text, /FILE src\/value.mjs/);
    assert.equal(body.text.format.strict, true);
    return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({
      files: [{ path: "src/value.mjs", content: "export const value=1;" }], summary: "fixed",
    }), usage: { input_tokens: 100, output_tokens: 20 } }));
  } });
  const result = await synthesize({ task: "Repair value.", evidence: "FILE src/value.mjs\nexport const value=0;" });
  assert.equal(calls, 1);
  assert.equal(result.model, "gpt-6-sol");
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.usage?.inputTokens, 100);
});

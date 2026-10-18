# Backend model boundary

`bedrock.ts` is the preparatory Opus 4.6 adapter for LLD sections 1, 2, 7 and 9.
It is not a deployed gateway or a replacement for the frozen Master-1 scorer.
The run controller must create one `OpusRun` per authenticated run, supply bounded
evidence and the authorized write set, then apply returned patches through
workspace locks and version checks. This module never writes files or runs code.

- Model: `us.anthropic.claude-opus-4-6-v1`, Bedrock ConverseStream, adaptive
  thinking with medium effort. Reasoning content is not returned or logged.
- Default limits: 3 calls/run (failed attempts count), 120 seconds/call,
  8,192 output tokens; no SDK retries. Input evidence is capped at 100,000
  characters. Output, file count and paths are validated before success.
- Receipts contain identity, model, purpose, outcome, request ID, usage and
  elapsed time, not credentials/prompts. Unknown token usage is null, not zero.
- Use the backend AWS credential chain with a least-privilege role permitting
  this inference profile and its destination models. Never give AWS credentials
  to the browser, Rust CLI, task text or sandbox. No root credentials are needed.
- The production run controller, cross-run admission/cost caps, account/model
  access and live AWS smoke test remain release gates. The adapter is not wired
  into `main.ts`; adding it does not make `noHarness` run real coding tasks.

Verification: `npm test -w @pineagent/api -- tests/bedrock.test.ts` and
`npm run typecheck -w @pineagent/api`. Tests use synthetic streams, not paid calls.
Changing the coding model requires new end-to-end quality evidence; previous
Sol benchmark results do not establish Opus performance.

References:
- https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-6.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html

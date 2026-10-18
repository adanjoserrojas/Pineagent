# Pineagent / Codex paired JavaScript evaluation

Owner and reviewer: Software Engineer 1, with human review before merge.
Requirement: compare autonomous correctness, total inference usage and elapsed time on identical JavaScript repair tasks without modifying the frozen harness.

## Frozen experiment

- Harness source: remote `main` commit `9076b82b5d126a314b847bd94da842c5ac34e38b`, fetched before branching. Record its complete harness tree hash. Never silently refresh during a study.
- Arm A: that commit's exported frozen V8 factories, including its approval gate, fixed history, recovery and one Codex warm fallback.
- Arm B: installed Codex CLI version 0.163.0, pinned in the container.
- Both coding paths: `gpt-6-sol`, medium reasoning, identical task statement, initial files, allowed source edits, CPU, RAM and whole-trial deadline. Record provider-reported model when available. A model alias does not guarantee an immutable backend snapshot.
- Routing is part of Arm A. The experiment compares complete systems, not model intelligence in isolation. Their prompts and tool policies intentionally differ. A later ablation can isolate those mechanisms.
- Fresh container and workspace for every arm/task/repetition. Seeded randomized task and arm order. Sequential execution avoids resource contention. No prior conversation, personal skills, rules or home-directory mounts.
- Hidden tests and reference fixes remain on the host. The grader receives only the final allowed source files in a separate network-disabled container. Agent-authored tests never determine success.
- Pauses, invalid writes, timeouts and agent failures count as unsuccessful attempts. Infrastructure errors are reported separately and retained. No selective reruns or silent exclusions.

## Outcomes and decision rule

Primary quality: fraction of attempts passing every original visible and hidden assertion. Primary efficiency: total input plus output tokens across ALL requests, including routing, retries, failed responses with usage and warm fallback. Cached input is already part of input; reasoning is already part of output. Neither is added twice. Missing usage is unknown, never zero.

Also report cached input, reasoning tokens when exposed, provider request count, agent wall time, timeout/pause rate, and total tokens divided by successful tasks. Show efficiency on jointly solved pairs as a secondary outcome and disclose its survivor bias. Dollar costs require a dated provider price table and complete receipts, and remain separate from raw token savings. CLI subscription pricing is not equivalent to API cost.

Declare a quality-preserving efficiency improvement only when the paired 95% quality-difference interval is above -5 percentage points AND the paired token-ratio interval is below 1, with complete usage. Otherwise report the observed tradeoff or inconclusive evidence. This is a prespecified descriptive rule, not proof of universal superiority.

## Sampling

1. Run the bundled independently specified calibration tasks and reference fixes offline to validate the evaluator. These are authored fixtures, not an external benchmark.
2. Run a separate live pilot (at least 12 distinct issues, one paired repetition) to check endpoint access, metering, cost, runtime and failure rates. Pilot outcomes do not select favorable tasks.
3. Freeze a confirmatory corpus of at least 100 distinct held-out JavaScript issues across repair, validation, asynchronous behavior and cross-file propagation. Use three paired repetitions (600 agent trials) if the budget supports it. Prefer real repository issues with reproducible regression tests. Verify licenses and contamination limitations before importing.
4. Use pilot paired-discordance and log-token variance to plan sample size for the chosen detectable effect. 100 is a planning target, not a power guarantee. For a paired quality difference d, an approximate planning variance is (discordance - d*d)/N. Small effects can need hundreds or thousands of distinct issues.
5. Cluster bootstrap by task, retaining all repetitions together. Repetition is not an independent issue. Publish 95% intervals, counts and the frozen manifest. Do not stop because significance appears. Stop for a predefined budget or infrastructure failure and label incomplete campaigns.

## Acceptance and failure behavior

Automated checks must demonstrate deterministic pairing, reject duplicate trials, preserve unknown usage, avoid token double counting, reject fixture path escapes and symlinks, prove buggy fixtures fail and reference fixes pass, and verify hidden tests are absent from the agent image/workspace. Container smoke tests validate plumbing only and must never be presented as model results.

No cloud, firmware, browser or shared API changes belong to this task. All testbench changes receive atomic commits. Push all code and create a draft PR before any Docker invocation. Keep raw runs and credentials out of Git. Publish sanitized summaries and the final results deck only after inspection.

## Design corrections and limitations

- A gated refusal can save tokens while failing the task. Count it in quality.
- `execution.modelCalls` omits routing and is not a trustworthy inference or token metric. Meter at the transport boundary.
- Count Codex fallback in the harness arm. Describe it as V8 plus warm fallback.
- Local repeated synthetic exercises cannot justify claims about arbitrary repositories. Keep calibration, pilot and confirmatory evidence distinct.
- A frozen harness may contain newer production corrections than its historical design prose. The pinned source is authoritative for this comparison, with deviations documented.
- Provider caches cannot necessarily be cleared. Record cache usage, randomize order and discuss carryover.
- The primary experiment measures task-solving performance. It cannot directly measure the quality of private internal reasoning.

References: installed `codex exec --help` (0.163.0), `harness/docs/FROZEN_DESIGN.md`, `harness/src/frozen-config.ts`, and https://developers.openai.com/blog/codex-as-a-platform .

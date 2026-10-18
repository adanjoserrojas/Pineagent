# Paired JavaScript testbench

Read [PROTOCOL.md](PROTOCOL.md) before interpreting results. This package leaves `harness/` unchanged and builds its source from the pinned remote-main commit, not the active checkout.

## Local verification

```powershell
node --test testbench/test/*.test.mjs
```

The bundled 16 tasks are calibration fixtures with known fixes. Their hidden tests and fixes are excluded from the agent image. They are useful for a pilot, not a broad benchmark claim.

## Container execution

Commit and push every change and create a draft PR first. The runner verifies the branch head is on the remote and there are no uncommitted testbench changes before invoking Docker. It requires the PR URL as a provenance input.

```powershell
node testbench/src/run.mjs --pr https://github.com/adanjoserrojas/Pineagent/pull/NUMBER
```

Default mode is an offline two-task smoke test, four containers plus isolated graders. It performs no model requests and makes no repairs. The broken fixtures should still fail grading. `mode: smoke` prevents these runs from being presented as model successes.

With an existing API key available as `OPENAI_API_KEY` and an explicitly authorized token budget:

```powershell
node testbench/src/run.mjs --live --tasks 16 --repetitions 1 --max-tokens 1000000 --pr https://github.com/adanjoserrojas/Pineagent/pull/NUMBER
```

The number above is an example, not spending authorization. Live runs are billed by the provider. The campaign token stop applies between pairs so a pair can overshoot. Each arm has a 50-request / 200,000-observed-token guard, checked between requests, and a 10-minute deadline. These are not hard dollar limits. Configure a provider-side spending limit for strict billing control. A missing receipt stops subsequent inference in that arm and stops the campaign after the pair. Endpoint/model access must be confirmed with the pilot.

Real provider credentials remain in the host proxy. Containers receive only an ephemeral proxy capability limited to the frozen model endpoints. No home directories, auth files, Docker socket, hidden tests or reference fixes are mounted into agents. Containers run as a non-root user with limited CPU, RAM, processes and a read-only image. Graders have no network. The agent's network is a standard Docker bridge, not a complete egress sandbox. Use only reviewed trusted fixtures. Do not use this runner for arbitrary hostile repositories.

The host proxy meters Responses and Decisions usage, including retries and warm Codex fallback. It forwards SSE chunks and captures final usage. It does not save prompts or credentials. Unknown usage stays unknown. The benchmark caps each coding response at 8192 output tokens for both arms. This is an operational constraint on the Codex comparison arm and must be disclosed. Jev backup is disabled in this study because no Jev credential or metering adapter is configured; the main Decisions path and its ambiguity gate remain unchanged.

## External corpus and results

Use `--corpus path/to/reviewed-tasks.json` for an array with the same schema as `src/corpus.mjs`: id, category, prompt, allowedWrites, visibleTestPath, files, hidden and gold. All tasks must be self-contained JavaScript projects using Node's test runner, require no dependency installation, and permit editing existing source files only. Validate every original/fix pair before importing. This bounded format does not yet support arbitrary npm repositories.

Results are under ignored `testbench/runs/<timestamp>/`: pinned manifest, append-only results and receipts, final workspaces, grading logs, and a summary with task-clustered intervals. Keep raw workspaces private. Summary regeneration:

```powershell
node testbench/src/report.mjs testbench/runs/RUN
```

Report calibration, smoke, pilot and confirmatory results separately. A completed Docker run does not establish a token-saving or correctness advantage.

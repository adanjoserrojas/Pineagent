# Frozen V8 harness — TypeScript

Software Engineer 1's bounded Direct DAG runtime for code repair and small function implementation. The owner approved this design freeze and TypeScript transfer. This package is not yet connected to the collaborative workspace and is not a production sandbox.

## Layout

- `src/master-tool-0.ts`: deterministic, dependency-aware candidate generation.
- `src/master-tool-1.ts`: Decisions selection, unchanged confidence/margin gate and Jev availability backup.
- `src/frozen-config.ts`: V8 provider, gate, model and offline history configuration.
- `src/v8-executor.ts`: one read-only expansion/reassessment and the pre-synthesis approval boundary.
- `src/v7-executor.ts`: deterministic discovery/checkpoints, one patch synthesis, verification and optional warm coding fallback.
- `src/sandbox-tools.ts`: local fixture tools; not a substitute for backend locks or OS isolation.
- `src/index.ts`: public package exports and types.
- `test/`: self-contained fixtures and offline reference comparison.
- `docs/`: frozen behavior, backend connection and transfer evidence.
- `FREEZE_MANIFEST.json`: source provenance and normalized-LF source hashes.

## Build and verify

Requires Node.js 22+ and npm. From this directory:

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run verify:freeze
```

Optional comparison with the owner's original source (no live provider calls):

```powershell
$env:FROZEN_JS_REFERENCE = 'C:\Users\17866\Downloads\Adan_Rojas_Workspace_2025\Pear\harness'
npm run verify:reference
```

This builds ESM JavaScript and declarations under ignored `dist/`; source remains strict TypeScript. No runtime npm dependencies. Do not commit `node_modules`, `dist`, credentials, original benchmark corpora or generated runs.

## Host composition

The backend supplies the task, an isolated root, metered provider access and an optional owner-container warm fallback. Credentials stay server-side and must never be included in task/evidence/logs. This illustrates core composition, not a completed backend adapter:

```typescript
import {
  selectCandidateDags, prototypeTools, createFrozenRouter,
  createFrozenSynthesize, executeV8Dag, FROZEN_HISTORY,
} from "@pineagent/harness";
import type { HarnessTask, FallbackAgent, FetchLike } from "@pineagent/harness";

async function runIsolatedTask(input: {
  root: string;
  task: HarnessTask & { id: string };
  decisionsKey: string;
  jevKey?: string;
  meteredFetch: FetchLike;
  ownerContainerFallback: FallbackAgent;
}) {
  const candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
  return executeV8Dag({
    trialRoot: input.root,
    task: input.task,
    candidates,
    history: FROZEN_HISTORY,
    router: createFrozenRouter({ decisionsApiKey: input.decisionsKey,
      jevApiKey: input.jevKey, fetchImpl: input.meteredFetch }),
    synthesize: createFrozenSynthesize({ apiKey: input.decisionsKey, fetchImpl: input.meteredFetch }),
    fallbackAgent: input.ownerContainerFallback,
  });
}
```

Use the frozen factories for the demo. The low-level configurable clients retain their historical defaults and are not the frozen demo configuration. Construct a router per run; do not update history from current task results. The host must meter both provider routes, synthesis and fallback; auto-reload is not a spending guard.

See [Frozen design](docs/FROZEN_DESIGN.md), [Backend integration](docs/BACKEND_INTEGRATION.md) and [Verification/handoff](docs/VERIFICATION.md). Shared backend/browser contracts remain outside this package.

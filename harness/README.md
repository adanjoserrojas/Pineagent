# Frozen V8 harness — TypeScript

Software Engineer 1's bounded Direct DAG runtime. The production revision connects it to the backend workspace authority and builds bounded Node/Python features from requirements, including new modules, existing callers and new acceptance tests. It preserves deterministic DAG execution and the frozen routing thresholds. See [Production handoff](docs/PRODUCTION_HANDOFF.md) for behavior, verification and limits.

The original freeze remains the historical baseline. `INTEGRATION_MANIFEST.json` records explicit production overrides and additions; `FREEZE_MANIFEST.json` is unchanged. The local fixture runtime is not a production sandbox: the backend uses its Docker validator.

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

The backend supplies the task, workspace locks and versions, metered provider access and a bounded coding recovery. Credentials stay server-side and must never be included in task/evidence/logs. The live adapter is `services/api/src/harness/controller.ts`; the following is the historical standalone composition example:

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

The backend retains the frozen router factory and uses its existing Bedrock coding model. The standalone frozen synthesis factory above is the reference configuration. Construct a router per run; do not update history from current task results. The host must meter planning, both provider routes, synthesis and recovery; auto-reload is not a spending guard.

See [Frozen design](docs/FROZEN_DESIGN.md), [Backend integration](docs/BACKEND_INTEGRATION.md) and [Verification/handoff](docs/VERIFICATION.md). Shared backend/browser contracts remain outside this package.

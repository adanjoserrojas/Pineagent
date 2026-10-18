# V8 integration revision 2: Python repository adapter

Owner authorization: add Python support for My_App, preserve frozen routing and Crown (2026-10-18).

The optional `RepositoryLanguage` interface supplies file classification, manifest names,
and static local-import resolution. Omission preserves the original JavaScript collector.
The Python implementation lives in `services/api/src/harness/python.ts`, outside the
frozen policy. It supports root modules, packages, relative imports, and a `src/` layout.
Dynamic imports and custom import hooks are not resolved. This is not general support
for every Python build system or for arbitrary third-party dependencies.

Unchanged: Master-0 candidates and IDs; Master-1 score threshold and margin; route
history; two adaptive checkpoints; one bounded read-only recovery (12 files, 24,000
characters, 10 seconds); reassessment and owner approval; synthesis and warm fallback.
Evidence must still contain a source and the visible test before synthesis. Python
source classification replaces the JavaScript-specific `src/` convention, not the gate.

Production selects the adapter from the validated visible test and rejects mixed
Python/non-Python write scopes. Python tests and test-runner configuration cannot be patch targets.
Backend reads, version observations, atomic run locks, patch writes, and broadcasts
remain authoritative. Tests use the same read-only Docker isolation and 120-second
timeout, with fixed argv for pytest instead of Node. A zero-test pytest result fails.
No dependency installation, shell commands, or extra model calls are introduced by
the adapter. Dependencies must be reviewed and baked into the immutable sandbox image.

The original FREEZE_MANIFEST is retained. INTEGRATION_MANIFEST records the same
three runtime overrides as revision 1; all router, selector, history and config
hashes remain unchanged. The JavaScript suite remains a regression gate; Python
integration evidence does not extend the earlier inference benchmark to Python.

Acceptance: real My_App tests in Docker, a versioned Python patch followed by those
tests, low-confidence read-only recovery and pause, unchanged JS regression suite,
and authenticated Ratatui input/output/resize. Live deployment is a separate gate.

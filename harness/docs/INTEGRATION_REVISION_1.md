# V8 backend integration revision 1

Owner approval in the implementation conversation: “Yes—add the adapter,
preserve routing policy.” The optional `runtimeFactory` changes the execution
transport, not the decision policy. No new model invocation or router invocation
is introduced by this seam.

Master-0, Master-1, registry, candidate IDs, history priors, confidence/margin gate,
adaptive checkpoints, single bounded read-only recovery, reassessment, evidence
gate, and warm-fallback conditions are unchanged. Default benchmark behavior is
unchanged. Production must inject the adapter; the default local runtime remains
a benchmark fixture and must not execute untrusted repositories on the API host.

All file listing/search/reads, dependency-graph reads, current-patch reads, writes,
and test commands are routed through the adapter when supplied. Recovery receives
an empty write set. The backend must enforce its own authenticated owner, path
scope, locks, versions, cancellation, resource limits, and container boundary.
Fallback implementation remains a backend responsibility through the existing
fallback callback; it must use the same authority, not direct host filesystem I/O.

`FREEZE_MANIFEST.json` remains the original historical artifact, byte-for-byte.
`INTEGRATION_MANIFEST.json` records its normalized hash, original hashes of the
four permitted overrides, replacement hashes, and the added verification files.
The freeze check rejects edits to policy files or any unrecorded override. This
is explicitly an integration revision, not a claim that original source hashes
still match changed files.

Verification: existing harness tests, seven offline comparisons against the
original Pear V8 implementation, adapter-only virtual-filesystem execution, and
the revised provenance check. These establish tested behavior/parity, not an
absolute proof over all inputs. Docker scheduling, synchronization and stricter
resource limits can change wall time or produce safety failures; previous
benchmark speed/accuracy results do not automatically transfer to deployment.

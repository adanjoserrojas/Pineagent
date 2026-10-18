import test from "node:test";
import assert from "node:assert/strict";
import { materializePatch, contentHash } from "../src/structured-patch.js";
test("compact edits preserve unchanged code and combine with new feature files", () => {
  const base = { path: "app.py", content: "# preserve\nvalue = 1\n" };
  const patch = materializePatch({ files: [{ path: "feature.py", content: "feature = True" }],
    edits: [{ path: base.path, baseSha256: contentHash(base.content), changes: [{ before: "value = 1", after: "value = 2" }] }] },
    [base.path, "feature.py"], [base]);
  assert.equal(patch[1].content, "# preserve\nvalue = 2\n");
});
test("stale hashes, ambiguous edits and duplicate targets never materialize", () => {
  const base = { path: "app.py", content: "value\nvalue\n" };
  const edit = { path: base.path, baseSha256: contentHash(base.content), changes: [{ before: "value", after: "new" }] };
  assert.throws(() => materializePatch({ edits: [edit] }, [base.path], [base]), /ambiguous/);
  assert.throws(() => materializePatch({ edits: [{ ...edit, baseSha256: "stale" }] }, [base.path], [base]), /hash/);
  assert.throws(() => materializePatch({ files: [{ path: base.path, content: "a" }, { path: base.path, content: "b" }] }, [base.path]), /Invalid/);
});

// Explicit maintainer action after reviewing a functional unit. Never runs as a test hook.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
const original = await readFile(path.join(root, 'FREEZE_MANIFEST.json'), 'utf8');
const baseline = JSON.parse(original).normalizedLfSha256;
const overrides = {}, additions = {};
for (const [file, originalSha256] of Object.entries(baseline)) {
  const integrationSha256 = hash(await readFile(path.join(root, file), 'utf8'));
  if (integrationSha256 !== originalSha256) overrides[file] = { originalSha256, integrationSha256 };
}
for (const directory of ['src', 'test', 'docs', 'scripts']) {
  for (const file of (await readdir(path.join(root, directory))).sort()) {
    const relative = `${directory}/${file}`;
    if (!Object.hasOwn(baseline, relative)) additions[relative] = hash(await readFile(path.join(root, relative), 'utf8'));
  }
}
await writeFile(path.join(root, 'INTEGRATION_MANIFEST.json'), JSON.stringify({
  revision: 'V8-production-3',
  approval: 'Owner requested feature building and production hardening on fix/harness-production; DAG candidates and routing thresholds retained',
  baseManifestSha256: hash(original), overrides, additions,
}, null, 2) + '\n');

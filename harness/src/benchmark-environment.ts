export function benchmarkEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|FIXTURE_ROOT|CODEX_THREAD|NODE_TEST_CONTEXT)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

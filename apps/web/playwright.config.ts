import { defineConfig, devices } from "@playwright/test";

// e2e runs its own mock and Vite on separate ports, so it never shares a room with a developer's
// signed-in session on the default dev servers (3001 / 5173).
const MOCK_PORT = 3101;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  retries: 0,
  // Several browsers loading Monaco cold from the Vite dev server can take longer than the 5 s default.
  expect: { timeout: 10_000 },
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx tsx mock/server.ts",
      port: MOCK_PORT,
      // MOCK_AVATARS=0 keeps e2e runs off github.com; avatars fall back to initials.
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_AVATARS: "0" },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      // Environment variables win over .env.local in Vite.
      env: { VITE_API_URL: `http://localhost:${MOCK_PORT}` },
    },
  ],
});

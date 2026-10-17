import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  retries: 0,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    // MOCK_AVATARS=0 keeps e2e runs off github.com; avatars fall back to initials.
    { command: "npm run mock", port: 3001, reuseExistingServer: !process.env.CI, env: { MOCK_AVATARS: "0" } },
    { command: "npm run dev:web", port: 5173, reuseExistingServer: !process.env.CI },
  ],
});

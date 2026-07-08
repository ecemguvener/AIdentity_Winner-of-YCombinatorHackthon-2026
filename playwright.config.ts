import { defineConfig, devices } from "@playwright/test";

const apiPort = Number(process.env.E2E_API_PORT ?? 4101);
const webPort = Number(process.env.E2E_WEB_PORT ?? 4899);

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["line"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: `E2E_API_PORT=${apiPort} E2E_WEB_PORT=${webPort} npx tsx scripts/e2e-server.ts`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});

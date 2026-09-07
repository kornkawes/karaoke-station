import { defineConfig } from "@playwright/test";

const port = 43180;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /hosted.*\.spec\.js/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "msedge",
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node server/hosted/index.js",
    cwd: ".",
    url: `http://127.0.0.1:${port}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      PORT: String(port),
      // Same-origin only; the browser sends no Origin for these navigations.
      ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      YOUTUBE_API_KEY: ""
    }
  }
});

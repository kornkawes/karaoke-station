import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hostPort = 43173;
const partyPort = 43174;
const e2eDataDir = join(tmpdir(), "karaoke-station-e2e-current");

export default defineConfig({
  testDir: "./tests/e2e",
  // The hosted lane has its own config/server; this one covers the legacy local app.
  testIgnore: /hosted.*\.spec\.js/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalTeardown: "./tests/e2e/global-teardown.js",
  use: {
    baseURL: `http://127.0.0.1:${hostPort}`,
    channel: "msedge",
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node server/index.js",
    cwd: ".",
    url: `http://127.0.0.1:${hostPort}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      PORT: String(hostPort),
      PARTY_PORT: String(partyPort),
      DATA_DIR: e2eDataDir
    }
  },
  metadata: { partyPort }
});

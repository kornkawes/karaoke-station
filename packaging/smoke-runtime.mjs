import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const stageDir = path.resolve(process.argv[2] ?? "packaging/.stage");
const expectedNodeVersion = process.argv[3] ?? "v22.23.1";
const appDir = path.join(stageDir, "app");
const serverEntry = existsSync(path.join(appDir, "server", "index.cjs"))
  ? "server/index.cjs"
  : "server/index.js";
const architectures = ["win-x64", "win-x86"];

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Runtime exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Runtime health timeout");
}

async function smoke(architecture) {
  const nodePath = path.join(stageDir, "runtime", architecture, "node.exe");
  const version = spawnSync(nodePath, ["--version"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (version.status !== 0 || version.stdout.trim() !== expectedNodeVersion) {
    throw new Error(`${architecture} Node version check failed`);
  }
  const [port, partyPort] = await Promise.all([freePort(), freePort()]);
  const dataDir = await mkdtemp(path.join(tmpdir(), `karaoke-${architecture}-`));
  let output = "";
  const child = spawn(nodePath, [serverEntry], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      PARTY_PORT: String(partyPort),
      DATA_DIR: dataDir,
      PATH: path.dirname(nodePath),
      YOUTUBE_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(`${baseUrl}/api/v1/health`, child);
    const response = await fetch(`${baseUrl}/api/v1/party/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const body = await response.json();
    if (!response.ok || !body.data?.sessionId || !body.data?.joinPath?.startsWith("/party#join=")) {
      throw new Error(`${architecture} Party session smoke failed`);
    }
    if (output.includes(body.data.pin) || output.includes(body.data.joinPath)) {
      throw new Error(`${architecture} runtime logged a Party secret`);
    }
    return {
      architecture,
      nodeVersion: version.stdout.trim(),
      health: "PASS",
      partySession: "PASS",
      secretLogCheck: "PASS",
      waitingUrls: body.data.urls.length
    };
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const results = [];
for (const architecture of architectures) {
  results.push(await smoke(architecture));
}
process.stdout.write(`${JSON.stringify({ stageDir, results }, null, 2)}\n`);

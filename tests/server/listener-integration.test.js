import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children = [];
const tempDirs = [];

function privateIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((address) => address?.family === "IPv4" && !address.internal)
    .filter((address) => (
      address.address.startsWith("10.") ||
      address.address.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address.address)
    ))
    .map((address) => address.address);
}

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child has not bound the loopback listener yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for KaraokeStation health");
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
  }));
  await Promise.all(tempDirs.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ));
});

describe("real Party listener startup", () => {
  it("waits for the LAN bind and returns fragment join URLs on the first start response", async () => {
    const [port, partyPort] = await Promise.all([freePort(), freePort()]);
    const dataDir = await mkdtemp(path.join(tmpdir(), "karaoke-listener-"));
    tempDirs.push(dataDir);
    let output = "";
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PORT: String(port),
        PARTY_PORT: String(partyPort),
        DATA_DIR: dataDir,
        YOUTUBE_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    children.push(child);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(`${baseUrl}/api/v1/health`, child);

    const response = await fetch(`${baseUrl}/api/v1/party/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.enabled).toBe(true);
    const addresses = privateIpv4Addresses();
    expect(body.data.urls).toHaveLength(addresses.length);
    for (const address of addresses) {
      expect(body.data.urls).toContainEqual(
        expect.stringMatching(
          new RegExp(`^http://${address.replaceAll(".", "\\.")}:${partyPort}/party#join=[A-Za-z0-9_-]+$`)
        )
      );
    }
    if (addresses.length) {
      expect(body.data.urls[0]).not.toContain("127.0.0.1");
    }
    expect(output).not.toContain(body.data.pin);
    expect(output).not.toContain(body.data.joinPath);
  }, 15_000);
});

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let child;
let baseUrl;

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

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy");
}

async function api(method, routePath, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? JSON.stringify({}) : JSON.stringify(body)
  });
  const payload = await response.json();
  return { status: response.status, ...payload };
}

function connect(auth, options = {}) {
  return ioClient(baseUrl, {
    auth,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    ...options
  });
}

/**
 * Resolves on connect, rejects with the server-sent error code on refusal.
 * The snapshot emitted during connect is buffered on the socket so tests can await
 * it without racing delivery.
 */
function connectResult(auth) {
  return new Promise((resolve, reject) => {
    const socket = connect(auth);
    socket.snapshots = [];
    socket.on("room:snapshot", (payload) => socket.snapshots.push(payload));
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timeout"));
    }, 5_000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(Object.assign(new Error(error.message), { code: error.data?.code }));
    });
  });
}

function connectResultWithOptions(auth, options) {
  return new Promise((resolve, reject) => {
    const socket = connect(auth, options);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timeout"));
    }, 5_000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

/** Returns the connect-time snapshot if it already arrived, otherwise waits. */
async function snapshotOf(socket) {
  if (socket.snapshots.length > 0) return socket.snapshots[0];
  return nextEvent(socket, "room:snapshot");
}

function nextEvent(socket, eventName, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${eventName}`)), timeoutMs);
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function createRoom() {
  const response = await api("POST", "/api/v1/rooms");
  expect(response.status).toBe(201);
  return response.data;
}

async function joinRoom(room, displayName = "phone") {
  const response = await api("POST", `/api/v1/rooms/${room.roomId}/join`, {
    body: { joinToken: room.joinToken, displayName }
  });
  expect(response.status).toBe(201);
  return response.data;
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(projectDir, "server", "hosted", "index.js")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      YOUTUBE_API_KEY: "",
      ALLOWED_ORIGINS: baseUrl,
      DOTENV_CONFIG_QUIET: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  await waitForHealth(`${baseUrl}/api/v1/health`);
}, 30_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

describe("socket authentication", () => {
  it.each(["websocket", "polling"])(
    "rejects a disallowed Origin over %s",
    async (transport) => {
      const room = await createRoom();
      await expect(connectResultWithOptions(
        { roomId: room.roomId, token: room.hostToken },
        {
          transports: [transport],
          extraHeaders: { Origin: "https://evil.example" }
        }
      )).rejects.toBeDefined();
    }
  );

  it("accepts a host token for its own room", async () => {
    const room = await createRoom();
    const socket = await connectResult({ roomId: room.roomId, token: room.hostToken });
    const snapshot = await snapshotOf(socket);
    expect(snapshot.roomId).toBe(room.roomId);
    socket.close();
  });

  it("accepts a controller token for its own room", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);
    const socket = await connectResult({ roomId: room.roomId, token: controller.token });
    const snapshot = await snapshotOf(socket);
    expect(snapshot.roomId).toBe(room.roomId);
    socket.close();
  });

  it("rejects a connection with no token", async () => {
    const room = await createRoom();
    await expect(connectResult({ roomId: room.roomId })).rejects.toMatchObject({
      code: "socket_auth_failed"
    });
  });

  it("rejects a cross-room subscription", async () => {
    const roomA = await createRoom();
    const roomB = await createRoom();
    const controllerA = await joinRoom(roomA);

    await expect(
      connectResult({ roomId: roomB.roomId, token: controllerA.token })
    ).rejects.toMatchObject({ code: "controller_session_expired" });
  });

  it("rejects a host token from another room", async () => {
    const roomA = await createRoom();
    const roomB = await createRoom();
    await expect(
      connectResult({ roomId: roomB.roomId, token: roomA.hostToken })
    ).rejects.toMatchObject({ code: "controller_session_expired" });
  });

  it("rejects an unknown room", async () => {
    await expect(
      connectResult({ roomId: "AAAAAAAA", token: "a".repeat(43) })
    ).rejects.toMatchObject({ code: "room_not_found" });
  });
});

describe("socket connection quota", () => {
  it("caps concurrent sockets for a single bearer", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);
    const sockets = [];

    for (let index = 0; index < 3; index += 1) {
      sockets.push(await connectResult({ roomId: room.roomId, token: controller.token }));
    }
    await expect(
      connectResult({ roomId: room.roomId, token: controller.token })
    ).rejects.toMatchObject({ code: "socket_limit" });

    for (const socket of sockets) socket.close();
  });
});

describe("realtime room events", () => {
  it("broadcasts the controller-only presence count after a join", async () => {
    const room = await createRoom();
    const hostSocket = await connectResult({ roomId: room.roomId, token: room.hostToken });
    const presenceEvents = [];
    hostSocket.on("room:presence", (payload) => presenceEvents.push(payload));

    await joinRoom(room, "presence phone");
    for (let attempt = 0; attempt < 20 && !presenceEvents.some((payload) => payload.controllerCount === 1); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(presenceEvents.some((payload) => payload.controllerCount === 1)).toBe(true);
    hostSocket.close();
  });

  it("broadcasts a queue change to every member of the room only", async () => {
    const room = await createRoom();
    const other = await createRoom();
    const controller = await joinRoom(room);

    const memberSocket = await connectResult({ roomId: room.roomId, token: controller.token });
    const outsiderSocket = await connectResult({ roomId: other.roomId, token: other.hostToken });
    // Ask for a fresh snapshot rather than racing the one emitted on connect.
    const memberReady = nextEvent(memberSocket, "room:snapshot");
    const outsiderReady = nextEvent(outsiderSocket, "room:snapshot");
    memberSocket.emit("room:sync");
    outsiderSocket.emit("room:sync");
    await Promise.all([memberReady, outsiderReady]);

    let outsiderSawChange = false;
    outsiderSocket.on("room:changed", () => { outsiderSawChange = true; });

    const changed = nextEvent(memberSocket, "room:changed");
    const added = await api("POST", `/api/v1/rooms/${room.roomId}/queue`, {
      token: room.hostToken,
      body: {
        track: {
          videoId: "dQw4w9WgXcQ",
          title: "เพลงทดสอบ",
          thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
        }
      }
    });
    expect(added.status).toBe(201);

    const payload = await changed;
    expect(payload.roomId).toBe(room.roomId);
    expect(payload.current.videoId).toBe("dQw4w9WgXcQ");
    expect(outsiderSawChange).toBe(false);

    memberSocket.close();
    outsiderSocket.close();
  });

  it("disconnects live sockets when the room rotates", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);
    const socket = await connectResult({ roomId: room.roomId, token: controller.token });
    await snapshotOf(socket);

    const revoked = nextEvent(socket, "room:revoked");
    const rotated = await api("POST", `/api/v1/rooms/${room.roomId}/rotate`, {
      token: room.hostToken
    });
    expect(rotated.status).toBe(200);

    const payload = await revoked;
    expect(payload.code).toBe("room_rotated");
    socket.close();
  });

  it("disconnects live sockets when the room closes", async () => {
    const room = await createRoom();
    const socket = await connectResult({ roomId: room.roomId, token: room.hostToken });
    await snapshotOf(socket);

    const revoked = nextEvent(socket, "room:revoked");
    const closed = await api("DELETE", `/api/v1/rooms/${room.roomId}`, { token: room.hostToken });
    expect(closed.status).toBe(200);

    const payload = await revoked;
    expect(payload.code).toBe("room_closed");
    socket.close();
  });

  it("does not leak the API key or tokens in any broadcast payload", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);
    const socket = await connectResult({ roomId: room.roomId, token: controller.token });
    const snapshot = await snapshotOf(socket);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(room.hostToken);
    expect(serialized).not.toContain(room.joinToken);
    expect(serialized).not.toContain(controller.token);
    socket.close();
  });
});

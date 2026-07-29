import "dotenv/config";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SocketServer } from "socket.io";
import { createHostedApplication } from "./app.js";
import { authenticateController, authenticateHost } from "./auth.js";
import { socketHandshakeSchema } from "./schemas.js";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(serverDir, "..", "..");
const port = Number(process.env.PORT) || 8080;
const distDir = path.resolve(projectDir, "dist");

const MAX_SOCKETS_PER_TOKEN = 3;
const MAX_SOCKETS_PER_ROOM = 60;
const SWEEP_INTERVAL_MS = 60_000;

const runtime = await createHostedApplication({
  env: process.env,
  distDir
});

const server = createServer(runtime.app);
const io = new SocketServer(server, {
  serveClient: false,
  cors: false,
  maxHttpBufferSize: 32 * 1024,
  transports: ["websocket", "polling"],
  pingInterval: 25_000,
  pingTimeout: 20_000
});

/** socketsPerToken keeps one bearer from opening unbounded connections (F-05). */
const socketsPerToken = new Map();

function countFor(map, key) {
  return map.get(key) ?? 0;
}

function increment(map, key) {
  map.set(key, countFor(map, key) + 1);
}

function decrement(map, key) {
  const next = countFor(map, key) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function roomChannel(roomId) {
  return `room:${roomId}`;
}

io.use((socket, next) => {
  try {
    const handshake = socketHandshakeSchema.parse({
      roomId: socket.handshake.auth?.roomId,
      token: socket.handshake.auth?.token
    });
    const room = runtime.store.get(handshake.roomId);
    if (!room) {
      const error = new Error("ไม่พบห้องนี้ หรือห้องหมดอายุแล้ว");
      error.data = { code: "room_not_found" };
      return next(error);
    }

    // Same role separation as REST: try host first, then controller. A token that
    // is neither is rejected, and a controller token can never gain host rights.
    let actor;
    try {
      actor = authenticateHost(room, handshake.token);
    } catch {
      actor = authenticateController(room, handshake.token);
    }

    const roomSockets = io.sockets.adapter.rooms.get(roomChannel(room.roomId))?.size ?? 0;
    if (roomSockets >= MAX_SOCKETS_PER_ROOM) {
      const error = new Error("ห้องนี้มีผู้เชื่อมต่อเต็มแล้ว");
      error.data = { code: "room_socket_limit" };
      return next(error);
    }
    if (countFor(socketsPerToken, handshake.token) >= MAX_SOCKETS_PER_TOKEN) {
      const error = new Error("เชื่อมต่อพร้อมกันมากเกินไป");
      error.data = { code: "socket_limit" };
      return next(error);
    }

    socket.data.roomId = room.roomId;
    socket.data.token = handshake.token;
    socket.data.role = actor.role;
    socket.data.displayName = actor.displayName ?? "Host";
    socket.data.expiresAt = actor.role === "host" ? room.expiresAt : actor.expiresAt;
    next();
  } catch (error) {
    const socketError = new Error(error.message ?? "ไม่สามารถเชื่อมต่อได้");
    socketError.data = { code: error.code ?? "socket_auth_failed" };
    next(socketError);
  }
});

io.on("connection", (socket) => {
  const { roomId, token } = socket.data;
  increment(socketsPerToken, token);
  socket.join(roomChannel(roomId));

  // Handshake auth alone is not enough: a socket that connected while the token
  // was valid must still be cut off the moment it expires (F-05).
  const remaining = socket.data.expiresAt - Date.now();
  const expiryTimer = setTimeout(() => {
    socket.emit("session:expired", { roomId });
    socket.disconnect(true);
  }, Math.max(remaining, 0));

  const room = runtime.store.get(roomId);
  if (room) {
    socket.emit("room:snapshot", runtime.roomView(room));
  }
  emitPresence(roomId);

  // Explicit resync for clients that reconnect or attach listeners after connect.
  socket.on("room:sync", () => {
    const current = runtime.store.get(roomId);
    if (current) socket.emit("room:snapshot", runtime.roomView(current));
  });

  socket.on("disconnect", () => {
    clearTimeout(expiryTimer);
    decrement(socketsPerToken, token);
    emitPresence(roomId);
  });
});

let presenceTimers = new Map();
/** Debounced so connect/disconnect storms cannot amplify into broadcast load. */
function emitPresence(roomId) {
  if (presenceTimers.has(roomId)) return;
  presenceTimers.set(roomId, setTimeout(() => {
    presenceTimers.delete(roomId);
    const count = io.sockets.adapter.rooms.get(roomChannel(roomId))?.size ?? 0;
    io.to(roomChannel(roomId)).emit("room:presence", { roomId, count });
  }, 500));
}

runtime.events.on("room:changed", ({ roomId, view }) => {
  io.to(roomChannel(roomId)).emit("room:changed", view);
});

runtime.events.on("room:action", (action) => {
  io.to(roomChannel(action.roomId)).emit("room:action", action);
});

async function disconnectRoom(roomId, code) {
  const sockets = await io.in(roomChannel(roomId)).fetchSockets();
  for (const socket of sockets) {
    socket.emit("room:revoked", { roomId, code });
    socket.disconnect(true);
  }
}

runtime.events.on("room:closed", ({ roomId }) => {
  void disconnectRoom(roomId, "room_closed");
});

// Rotation must invalidate live sockets too, not just future REST calls.
runtime.events.on("room:rotated", ({ roomId }) => {
  void disconnectRoom(roomId, "room_rotated");
});

const sweepTimer = setInterval(() => {
  const removed = runtime.store.sweep();
  if (removed > 0) console.log(`room sweep: removed ${removed} expired room(s)`);
}, SWEEP_INTERVAL_MS);
sweepTimer.unref?.();

server.listen(port, "0.0.0.0", () => {
  console.log(`KaraokeStation hosted: listening on :${port}`);
  if (!runtime.searchConfigured) {
    console.warn("YOUTUBE_API_KEY is not set — search is disabled until it is configured.");
  }
  if (runtime.allowedOrigins.length === 0) {
    console.warn("ALLOWED_ORIGINS is not set — cross-origin API calls will be rejected.");
  }
});

async function shutdown(signal) {
  console.log(`\nStopping KaraokeStation hosted (${signal})...`);
  clearInterval(sweepTimer);
  for (const timer of presenceTimers.values()) clearTimeout(timer);
  presenceTimers = new Map();
  await new Promise((resolve) => io.close(resolve));
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

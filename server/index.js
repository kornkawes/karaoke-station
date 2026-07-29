import "dotenv/config";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SocketServer } from "socket.io";
import { createApplication } from "./app.js";
import {
  allowHostSocketRequest,
  allowSameOriginSocketRequest,
  disconnectPartyGuests,
  partyListenerLogMessage
} from "./lib/socket-controls.js";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(serverDir, "..");
const port = Number(process.env.PORT) || 4173;
const partyPort = Number(process.env.PARTY_PORT) || 4174;
const defaultDataDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "KaraokeStation", "data")
  : path.resolve(projectDir, "data");
const dataDir = process.env.DATA_DIR
  ? path.resolve(projectDir, process.env.DATA_DIR)
  : defaultDataDir;
const distDir = path.resolve(projectDir, "dist");

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

function socketOptions(allowRequest) {
  return {
    serveClient: false,
    cors: false,
    allowRequest,
    maxHttpBufferSize: 64 * 1024,
    transports: ["websocket", "polling"]
  };
}

const runtime = await createApplication({
  dataDir,
  distDir,
  env: process.env,
  hostPort: port
});
const mainServer = createServer(runtime.app);
const hostIo = new SocketServer(mainServer, socketOptions(allowHostSocketRequest));
let partyServer = null;
let partyIo = null;

hostIo.on("connection", (socket) => {
  socket.emit("state:snapshot", runtime.repository.snapshot());
});

for (const eventName of ["queue:changed", "library:changed", "settings:changed"]) {
  runtime.events.on(eventName, (state) => {
    hostIo.emit(eventName, state);
  });
}

runtime.events.on("party:changed", (state) => {
  partyIo?.emit("party:changed", state);
});
runtime.events.on("party:action", (action) => {
  hostIo.emit("party:action", action);
  partyIo?.emit("party:action", action);
});

async function stopPartyServer() {
  runtime.app.locals.partyBaseUrls = [];
  if (partyIo) {
    partyIo.disconnectSockets(true);
    await new Promise((resolve) => partyIo.close(resolve));
    partyIo = null;
    partyServer = null;
  } else if (partyServer?.listening) {
    await new Promise((resolve) => partyServer.close(resolve));
    partyServer = null;
  }
}

async function startPartyServer() {
  if (partyServer) return;
  const nextPartyServer = createServer(runtime.app);
  const nextPartyIo = new SocketServer(nextPartyServer, socketOptions(allowSameOriginSocketRequest));
  nextPartyIo.use((socket, next) => {
    try {
      socket.partySession = runtime.partySessions.authenticate(socket.handshake.auth?.token);
      next();
    } catch (error) {
      const socketError = new Error(error.message);
      socketError.data = { code: error.code };
      next(socketError);
    }
  });
  nextPartyIo.on("connection", (socket) => {
    socket.emit("party:snapshot", runtime.publicPartyView());
    nextPartyIo.emit("guest:count", { count: nextPartyIo.engine.clientsCount });
    socket.on("disconnect", () => {
      nextPartyIo.emit("guest:count", { count: nextPartyIo.engine.clientsCount });
    });
  });
  try {
    await new Promise((resolve, reject) => {
      nextPartyServer.once("error", reject);
      nextPartyServer.listen(partyPort, "0.0.0.0", resolve);
    });
  } catch (error) {
    nextPartyIo.close();
    throw error;
  }
  partyServer = nextPartyServer;
  partyIo = nextPartyIo;
  runtime.app.locals.partyBaseUrls = privateIpv4Addresses().map(
    (address) => `http://${address}:${partyPort}`
  );
  console.log(partyListenerLogMessage(partyPort, runtime.app.locals.partyBaseUrls.length));
}

let partySync = Promise.resolve();
function syncPartyServer(enabled) {
  const operation = partySync.then(
    () => enabled ? startPartyServer() : stopPartyServer()
  );
  partySync = operation.catch(() => {});
  return operation;
}

runtime.events.on("settings:changed", (state) => {
  void syncPartyServer(state.settings.partyEnabled).catch((error) => {
    console.error("Party listener error:", error.message);
  });
});
runtime.events.on("party:listener:start", () => {
  void syncPartyServer(true).catch((error) => {
    console.error("Party listener error:", error.message);
  });
});
runtime.app.locals.ensurePartyListener = async () => {
  try {
    await syncPartyServer(true);
  } catch (error) {
    console.error("Party listener error:", error.message);
    throw error;
  }
};
runtime.events.on("party:rotated", () => {
  disconnectPartyGuests(partyIo);
  if (partyServer) {
    runtime.app.locals.partyBaseUrls = privateIpv4Addresses().map(
      (address) => `http://${address}:${partyPort}`
    );
  }
});

mainServer.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`KaraokeStation ทำงานอยู่แล้วที่ http://127.0.0.1:${port}`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

mainServer.listen(port, "127.0.0.1", () => {
  console.log(`KaraokeStation: http://127.0.0.1:${port}`);
  if (runtime.repository.snapshot().settings.partyEnabled) {
    void syncPartyServer(true).catch((error) => {
      console.error("Party listener error:", error.message);
    });
  }
});

async function shutdown(signal) {
  console.log(`\nStopping KaraokeStation (${signal})...`);
  await stopPartyServer();
  await new Promise((resolve) => hostIo.close(resolve));
  if (mainServer.listening) {
    await new Promise((resolve) => mainServer.close(resolve));
  }
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

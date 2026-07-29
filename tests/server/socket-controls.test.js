import { describe, expect, it, vi } from "vitest";
import {
  allowHostSocketRequest,
  allowSameOriginSocketRequest,
  disconnectPartyGuests,
  isHostSocketRequest,
  isSameOriginSocketRequest,
  partyListenerLogMessage
} from "../../server/lib/socket-controls.js";

function socketRequest({
  host,
  origin,
  localPort,
  remoteAddress = "192.168.1.20",
  encrypted = false,
  rawHeaders
}) {
  return {
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    rawHeaders,
    socket: { localPort, remoteAddress, encrypted }
  };
}

describe("disconnectPartyGuests", () => {
  it("force-disconnects every connected party socket after PIN rotation", () => {
    const disconnectSockets = vi.fn();
    const partyIo = {
      engine: { clientsCount: 3 },
      disconnectSockets
    };

    expect(disconnectPartyGuests(partyIo)).toBe(3);
    expect(disconnectSockets).toHaveBeenCalledOnce();
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it("is safe when Party Mode has no active listener", () => {
    expect(disconnectPartyGuests(null)).toBe(0);
  });
});

describe("Socket.IO same-origin handshake", () => {
  it.each([
    ["http://127.0.0.1:4173", "127.0.0.1:4173", 4173, false],
    ["http://localhost:5173", "localhost:5173", 5173, false],
    ["http://192.168.1.10:4174", "192.168.1.10:4174", 4174, false],
    ["https://[::1]:4174", "[::1]:4174", 4174, true]
  ])("accepts matching literal browser Origin %s and Host %s", (origin, host, localPort, encrypted) => {
    expect(isSameOriginSocketRequest(socketRequest({
      origin,
      host,
      localPort,
      encrypted
    }))).toBe(true);
  });

  it.each([
    ["https://evil.example", "127.0.0.1:4173", 4173],
    ["http://127.0.0.1:4174", "127.0.0.1:4173", 4173],
    ["not a url", "127.0.0.1:4173", 4173],
    ["http://127.0.0.1:4173", undefined, 4173],
    ["ws://127.0.0.1:4173", "127.0.0.1:4173", 4173],
    ["http://evil.example:4173", "evil.example:4173", 4173],
    ["http://127.0.0.1.evil:4173", "127.0.0.1.evil:4173", 4173],
    ["http://localhost.:4173", "localhost.:4173", 4173],
    ["http://localhost:4173", "user@localhost:4173", 4173],
    ["http://localhost:4173", "localhost:4173/path", 4173],
    ["http://localhost:4173", "localhost:4174", 4173]
  ])("rejects malformed, cross-origin, or unsafe authority", (origin, host, localPort) => {
    expect(isSameOriginSocketRequest(socketRequest({ origin, host, localPort }))).toBe(false);
  });

  it("accepts a polling/non-browser handshake only after validating Host and local port", () => {
    expect(isSameOriginSocketRequest(socketRequest({
      host: "127.0.0.1:4173",
      localPort: 4173
    }))).toBe(true);
  });

  it("uses the Engine.IO allowRequest callback contract", () => {
    const callback = vi.fn();
    allowSameOriginSocketRequest(socketRequest({
      origin: "http://localhost:4173",
      host: "localhost:4173",
      localPort: 4173
    }), callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("rejects duplicate Host headers", () => {
    expect(isSameOriginSocketRequest(socketRequest({
      host: "localhost:4173",
      origin: "http://localhost:4173",
      localPort: 4173,
      rawHeaders: ["Host", "localhost:4173", "Host", "evil.example:4173"]
    }))).toBe(false);
  });
});

describe("host Socket.IO handshake", () => {
  it.each([
    ["127.0.0.1:4173", "127.0.0.1"],
    ["LOCALHOST:4173", "::1"],
    ["[::1]:4173", "::ffff:127.0.0.1"]
  ])("accepts exact loopback Host %s from loopback remote", (host, remoteAddress) => {
    expect(isHostSocketRequest(socketRequest({
      host,
      origin: `http://${host}`,
      localPort: 4173,
      remoteAddress
    }))).toBe(true);
  });

  it.each([
    ["evil.example:4173", "127.0.0.1", 4173],
    ["127.0.0.1.evil:4173", "127.0.0.1", 4173],
    ["localhost.:4173", "127.0.0.1", 4173],
    ["localhost:4174", "127.0.0.1", 4173],
    ["localhost:4173", "192.168.1.20", 4173]
  ])("rejects unsafe host socket request (%s, %s)", (host, remoteAddress, localPort) => {
    expect(isHostSocketRequest(socketRequest({
      host,
      origin: `http://${host}`,
      localPort,
      remoteAddress
    }))).toBe(false);
  });

  it("uses a separate Engine.IO callback for host policy", () => {
    const callback = vi.fn();
    allowHostSocketRequest(socketRequest({
      host: "evil.example:4173",
      origin: "http://evil.example:4173",
      localPort: 4173,
      remoteAddress: "127.0.0.1"
    }), callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });
});

describe("Party listener logging", () => {
  it("reports listener metadata without a PIN or join URL", () => {
    const message = partyListenerLogMessage(4174, 2);
    expect(message).toBe("Party Mode active on LAN port 4174 (2 addresses)");
    expect(message).not.toContain("?code=");
    expect(message).not.toContain("123456");
    expect(message).not.toContain("http://");
  });
});

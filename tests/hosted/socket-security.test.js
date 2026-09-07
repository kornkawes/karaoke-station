import { describe, expect, it, vi } from "vitest";
import {
  clientAddress,
  createSocketAdmission,
  SocketAdmissionLimiter,
  socketSecurityConfig
} from "../../server/hosted/socket-security.js";

function handshake({
  origin = "https://karaoke.example",
  remoteAddress = "203.0.113.10",
  forwardedFor
} = {}) {
  return {
    headers: {
      ...(origin === undefined ? {} : { origin }),
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {})
    },
    socket: { remoteAddress }
  };
}

describe("socket admission security", () => {
  it("accepts only exact configured browser origins", () => {
    const callback = vi.fn();
    const admit = createSocketAdmission({
      allowedOrigins: ["https://karaoke.example"],
      config: {
        maxConnections: 10,
        globalHandshakeLimit: 10,
        ipHandshakeLimit: 10,
        trustedProxyHops: 0
      },
      activeConnections: () => 0
    });

    admit(handshake(), callback);
    expect(callback).toHaveBeenLastCalledWith(null, true);

    admit(handshake({ origin: "https://evil.example" }), callback);
    expect(callback).toHaveBeenLastCalledWith("origin not allowed", false);
  });

  it("limits both per-address and global unauthenticated handshakes", () => {
    const limiter = new SocketAdmissionLimiter({
      globalLimit: 3,
      ipLimit: 2,
      now: () => 1_000
    });
    expect(limiter.consume("203.0.113.1")).toBe(true);
    expect(limiter.consume("203.0.113.1")).toBe(true);
    expect(limiter.consume("203.0.113.1")).toBe(false);
    expect(limiter.consume("203.0.113.2")).toBe(true);
    expect(limiter.consume("203.0.113.3")).toBe(false);
  });

  it("rejects new handshakes at the instance-wide connection ceiling", () => {
    const callback = vi.fn();
    const admit = createSocketAdmission({
      allowedOrigins: ["https://karaoke.example"],
      config: {
        maxConnections: 10,
        globalHandshakeLimit: 30,
        ipHandshakeLimit: 10,
        trustedProxyHops: 0
      },
      activeConnections: () => 10
    });
    admit(handshake(), callback);
    expect(callback).toHaveBeenCalledWith("connection capacity reached", false);
  });

  it("ignores forwarded addresses until trusted proxy hops are explicit", () => {
    const request = handshake({
      remoteAddress: "10.0.0.8",
      forwardedFor: "198.51.100.2, 10.0.0.7"
    });
    expect(clientAddress(request, 0)).toBe("10.0.0.8");
    expect(clientAddress(request, 1)).toBe("10.0.0.7");
    expect(clientAddress(request, 2)).toBe("198.51.100.2");
  });

  it("uses conservative bounded defaults for malformed environment values", () => {
    expect(socketSecurityConfig({
      SOCKET_MAX_CONNECTIONS: "unlimited",
      SOCKET_GLOBAL_HANDSHAKES_PER_MINUTE: "-1",
      SOCKET_IP_HANDSHAKES_PER_MINUTE: "999999",
      TRUSTED_PROXY: "true"
    })).toEqual({
      maxConnections: 120,
      globalHandshakeLimit: 300,
      ipHandshakeLimit: 60,
      trustedProxyHops: 0
    });
  });
});

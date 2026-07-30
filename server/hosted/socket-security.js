import { isIP } from "node:net";
import { isAllowedOrigin } from "./app.js";
import { boundedInteger, trustedProxyHops } from "./config.js";

const DEFAULT_WINDOW_MS = 60_000;

export function socketSecurityConfig(env = process.env) {
  return {
    maxConnections: boundedInteger(env.SOCKET_MAX_CONNECTIONS, 120, 10, 1_000),
    globalHandshakeLimit: boundedInteger(env.SOCKET_GLOBAL_HANDSHAKES_PER_MINUTE, 300, 30, 5_000),
    ipHandshakeLimit: boundedInteger(env.SOCKET_IP_HANDSHAKES_PER_MINUTE, 60, 10, 1_000),
    trustedProxyHops: trustedProxyHops(env.TRUSTED_PROXY)
  };
}

/**
 * Resolves an address without trusting a client-supplied X-Forwarded-For header
 * unless an explicit number of proxy hops was configured.
 */
export function clientAddress(request, trustedProxyHops = 0) {
  const remoteAddress = request.socket?.remoteAddress;
  if (trustedProxyHops <= 0) return remoteAddress || "unknown";

  const forwarded = String(request.headers?.["x-forwarded-for"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => isIP(entry));
  const index = forwarded.length - trustedProxyHops;
  return forwarded[index] ?? remoteAddress ?? "unknown";
}

/** Sliding-window admission limiter for unauthenticated Engine.IO handshakes. */
export class SocketAdmissionLimiter {
  constructor({
    globalLimit = 300,
    ipLimit = 60,
    windowMs = DEFAULT_WINDOW_MS,
    now = () => Date.now()
  } = {}) {
    this.globalLimit = globalLimit;
    this.ipLimit = ipLimit;
    this.windowMs = windowMs;
    this.now = now;
    this.globalHits = [];
    this.ipHits = new Map();
  }

  consume(address) {
    const current = this.now();
    const cutoff = current - this.windowMs;
    this.globalHits = this.globalHits.filter((time) => time > cutoff);
    const recent = (this.ipHits.get(address) ?? []).filter((time) => time > cutoff);
    if (this.globalHits.length >= this.globalLimit || recent.length >= this.ipLimit) {
      return false;
    }
    this.globalHits.push(current);
    recent.push(current);
    this.ipHits.set(address, recent);
    if (this.ipHits.size > 5_000) this.prune(cutoff);
    return true;
  }

  prune(cutoff) {
    for (const [address, hits] of this.ipHits) {
      if (!hits.some((time) => time > cutoff)) this.ipHits.delete(address);
    }
  }
}

export function createSocketAdmission({
  allowedOrigins,
  config,
  activeConnections = () => 0,
  limiter = new SocketAdmissionLimiter({
    globalLimit: config.globalHandshakeLimit,
    ipLimit: config.ipHandshakeLimit
  })
}) {
  return (request, callback) => {
    if (!isAllowedOrigin(request, allowedOrigins)) {
      return callback("origin not allowed", false);
    }
    if (activeConnections() >= config.maxConnections) {
      return callback("connection capacity reached", false);
    }
    const address = clientAddress(request, config.trustedProxyHops);
    if (!limiter.consume(address)) {
      return callback("handshake rate limited", false);
    }
    callback(null, true);
  };
}

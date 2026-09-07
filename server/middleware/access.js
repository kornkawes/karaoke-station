import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { AppError } from "../lib/errors.js";
import { randomUuid, toBase64Url } from "../lib/compat.js";

export function isLoopbackAddress(address = "") {
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "::1" || normalized.startsWith("127.");
}

function hasSingleHeader(request, headerName) {
  if (!Array.isArray(request?.rawHeaders)) return true;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (String(request.rawHeaders[index]).toLowerCase() === headerName) count += 1;
  }
  return count === 1;
}

export function parseRequestAuthority(request, { loopbackOnly = false } = {}) {
  const host = request?.headers?.host;
  const localPort = Number(request?.socket?.localPort);
  if (
    typeof host !== "string" ||
    !host ||
    host !== host.trim() ||
    !hasSingleHeader(request, "host") ||
    !Number.isInteger(localPort) ||
    localPort < 1 ||
    localPort > 65_535 ||
    /[\s,/@\\?#]/u.test(host)
  ) {
    return null;
  }

  const bracketed = host.match(/^\[([0-9a-f:.]+)\]:(\d+)$/iu);
  const unbracketed = host.match(/^([^:]+):(\d+)$/u);
  const match = bracketed ?? unbracketed;
  if (!match) return null;

  const hostname = match[1].toLowerCase();
  const portText = match[2];
  const port = Number(portText);
  if (!Number.isInteger(port) || port !== localPort) return null;

  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return null;
  }
  const parsedHostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsedHostname !== hostname ||
    parsed.port !== portText ||
    parsed.host.toLowerCase() !== host.toLowerCase()
  ) {
    return null;
  }

  const ipVersion = isIP(hostname);
  const isExactLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (loopbackOnly ? !isExactLoopback : hostname !== "localhost" && ipVersion === 0) {
    return null;
  }
  if (bracketed && ipVersion !== 6) return null;
  if (!bracketed && hostname.includes(":")) return null;

  return {
    host: parsed.host.toLowerCase(),
    hostname,
    port,
    protocol: request?.socket?.encrypted ? "https:" : "http:"
  };
}

export function isSameOriginRequest(request, options) {
  const authority = parseRequestAuthority(request, options);
  if (!authority) return false;

  const origin = request?.headers?.origin;
  if (origin === undefined || origin === null || origin === "") return true;
  if (
    typeof origin !== "string" ||
    origin !== origin.trim() ||
    !hasSingleHeader(request, "origin") ||
    origin.includes(",")
  ) {
    return false;
  }

  try {
    const parsedOrigin = new URL(origin);
    return (
      parsedOrigin.protocol === authority.protocol &&
      parsedOrigin.username === "" &&
      parsedOrigin.password === "" &&
      parsedOrigin.pathname === "/" &&
      parsedOrigin.search === "" &&
      parsedOrigin.hash === "" &&
      parsedOrigin.host.toLowerCase() === authority.host
    );
  } catch {
    return false;
  }
}

export function requireLoopback(request, _response, next) {
  if (
    !isLoopbackAddress(request.socket.remoteAddress) ||
    !parseRequestAuthority(request, { loopbackOnly: true })
  ) {
    return next(new AppError(403, "host_only", "คำสั่งนี้ใช้ได้จากเครื่องหลักเท่านั้น"));
  }
  next();
}

function safeEqual(valueA, valueB) {
  const a = Buffer.from(String(valueA));
  const b = Buffer.from(String(valueB));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PartySessions {
  constructor({
    repository,
    sessionTtlMs = 12 * 60 * 60 * 1_000,
    maxSessions = 100
  }) {
    this.repository = repository;
    this.sessionTtlMs = sessionTtlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.requests = new Map();
    this.rotateLaunchSession();
  }

  rotateLaunchSession() {
    this.revokeAll();
    this.sessionId = toBase64Url(randomBytes(16));
    this.joinToken = toBase64Url(randomBytes(32));
    return this.sessionInfo();
  }

  sessionInfo() {
    return { sessionId: this.sessionId };
  }

  getJoinToken() {
    return this.joinToken;
  }

  join({ pin, joinToken, displayName }) {
    this.#pruneExpiredSessions();
    const validJoinToken = (
      joinToken &&
      this.repository.isPartySessionActive() &&
      safeEqual(joinToken, this.joinToken)
    );
    const validPin = pin && this.repository.isPartyPinValid(pin);
    if (!this.repository.snapshot().settings.partyEnabled || (!validJoinToken && !validPin)) {
      throw new AppError(401, "invalid_party_credential", "รหัสหรือคำเชิญปาร์ตี้ไม่ถูกต้องหรือหมดอายุ");
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new AppError(429, "party_session_limit", "มี controller เชื่อมต่อเต็มจำนวนแล้ว");
    }
    const token = toBase64Url(randomBytes(32));
    const expiresAt = Math.min(
      Date.now() + this.sessionTtlMs,
      Date.parse(this.repository.secretStatus().partyPinExpiresAt)
    );
    this.sessions.set(token, {
      displayName,
      expiresAt,
      sessionId: this.sessionId,
      controllerId: randomUuid()
    });
    return {
      token,
      displayName,
      expiresAt: new Date(expiresAt).toISOString(),
      sessionId: this.sessionId
    };
  }

  authenticate(token) {
    if (!token) throw new AppError(401, "party_auth_required", "กรุณาเข้าร่วมปาร์ตี้ก่อน");
    let matchedToken;
    for (const candidate of this.sessions.keys()) {
      if (safeEqual(candidate, token)) {
        matchedToken = candidate;
        break;
      }
    }
    const session = matchedToken ? this.sessions.get(matchedToken) : undefined;
    if (
      !session ||
      session.expiresAt <= Date.now() ||
      session.sessionId !== this.sessionId ||
      !this.repository.snapshot().settings.partyEnabled
    ) {
      if (matchedToken) this.sessions.delete(matchedToken);
      throw new AppError(401, "party_session_expired", "เซสชันปาร์ตี้หมดอายุ กรุณาเข้าร่วมใหม่");
    }
    return { token: matchedToken, ...session };
  }

  rateLimit(token) {
    const limit = this.repository.snapshot().settings.guestRateLimitPerMinute;
    const now = Date.now();
    const recent = (this.requests.get(token) ?? []).filter((timestamp) => timestamp > now - 60_000);
    if (recent.length >= limit) {
      throw new AppError(429, "party_rate_limited", "ส่งคำขอเร็วเกินไป กรุณารอสักครู่");
    }
    recent.push(now);
    this.requests.set(token, recent);
  }

  revokeAll() {
    this.sessions.clear();
    this.requests.clear();
  }

  #pruneExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now || session.sessionId !== this.sessionId) {
        this.sessions.delete(token);
        this.requests.delete(token);
      }
    }
  }
}

export function bearerToken(request) {
  const value = request.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export function partyAuth(sessions, { rateLimit = true } = {}) {
  return (request, _response, next) => {
    try {
      const session = sessions.authenticate(bearerToken(request));
      if (rateLimit) sessions.rateLimit(session.token);
      request.partySession = session;
      next();
    } catch (error) {
      next(error);
    }
  };
}

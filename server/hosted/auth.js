import { AppError } from "../lib/errors.js";
import { CONTROLLER_TTL_MS, generateToken, safeEqual } from "./rooms.js";

/**
 * Online threat boundary.
 *
 * Loopback is meaningless once hosted, so trust comes only from bearer tokens that
 * are scoped to exactly one room and one role:
 *
 *   hostToken       — created with the room, shown only on /display, never in a URL
 *   joinToken       — handed out via the QR fragment, exchanges for a controllerToken
 *   controllerToken — short-lived, queue permissions only
 *
 * Roles are stored in separate places (room.hostToken vs room.controllers), so a
 * token of one role can never authenticate as the other.
 */

export const MAX_CONTROLLERS_PER_ROOM = 50;

export function bearerToken(request) {
  const value = request.get?.("authorization") ?? request.headers?.authorization ?? "";
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export function authenticateHost(room, token) {
  if (!token) {
    throw new AppError(401, "host_auth_required", "ต้องใช้สิทธิ์เจ้าของห้อง");
  }
  if (!safeEqual(token, room.hostToken)) {
    throw new AppError(403, "host_token_invalid", "สิทธิ์เจ้าของห้องไม่ถูกต้องหรือถูกยกเลิกแล้ว");
  }
  return { role: "host", roomId: room.roomId };
}

export function authenticateController(room, token, { now = Date.now() } = {}) {
  if (!token) {
    throw new AppError(401, "controller_auth_required", "กรุณาเข้าร่วมห้องก่อน");
  }
  let matched;
  for (const candidate of room.controllers.keys()) {
    if (safeEqual(candidate, token)) {
      matched = candidate;
      break;
    }
  }
  const controller = matched ? room.controllers.get(matched) : undefined;
  if (!controller || controller.expiresAt <= now) {
    if (matched) room.controllers.delete(matched);
    throw new AppError(401, "controller_session_expired", "เซสชันหมดอายุ กรุณาเข้าร่วมห้องใหม่");
  }
  return { role: "controller", roomId: room.roomId, token: matched, ...controller };
}

export function joinRoom(room, { joinToken, displayName }, { now = Date.now() } = {}) {
  if (!joinToken || !safeEqual(joinToken, room.joinToken)) {
    throw new AppError(401, "join_token_invalid", "ลิงก์เข้าห้องไม่ถูกต้องหรือหมดอายุแล้ว");
  }
  for (const [token, controller] of room.controllers) {
    if (controller.expiresAt <= now) room.controllers.delete(token);
  }
  if (room.controllers.size >= MAX_CONTROLLERS_PER_ROOM) {
    throw new AppError(429, "controller_limit", "มีผู้เข้าร่วมเต็มจำนวนแล้ว");
  }
  const token = generateToken();
  const expiresAt = Math.min(now + CONTROLLER_TTL_MS, room.expiresAt);
  room.controllers.set(token, { displayName, expiresAt, joinedAt: now });
  return {
    token,
    displayName,
    roomId: room.roomId,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

/**
 * Express middleware factories. Both resolve the room from the route parameter
 * first, so a valid token for room A cannot reach room B's data.
 */
export function requireHost(store, { rateLimiter } = {}) {
  return (request, _response, next) => {
    try {
      const room = store.require(request.params.roomId);
      request.room = room;
      request.actor = authenticateHost(room, bearerToken(request));
      if (rateLimiter) rateLimiter.consume(room.hostToken);
      store.touch(room.roomId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireController(store, { rateLimiter, now = () => Date.now() } = {}) {
  return (request, _response, next) => {
    try {
      const room = store.require(request.params.roomId);
      request.room = room;
      const actor = authenticateController(room, bearerToken(request), { now: now() });
      if (rateLimiter) rateLimiter.consume(actor.token);
      request.actor = actor;
      store.touch(room.roomId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Accepts either role — for reads both host and controllers are allowed. */
export function requireMember(
  store,
  { rateLimiter, hostRateLimiter, now = () => Date.now() } = {}
) {
  return (request, _response, next) => {
    try {
      const room = store.require(request.params.roomId);
      const token = bearerToken(request);
      request.room = room;
      let actor;
      let isHost = false;
      try {
        actor = authenticateHost(room, token);
        isHost = true;
      } catch {
        actor = authenticateController(room, token, { now: now() });
      }
      if (isHost && hostRateLimiter) hostRateLimiter.consume(room.hostToken);
      if (!isHost && rateLimiter) rateLimiter.consume(actor.token);
      request.actor = actor;
      store.touch(room.roomId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Sliding-window limiter keyed by bearer token. */
export class TokenRateLimiter {
  constructor({ limit = 30, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  consume(key) {
    const current = this.now();
    const recent = (this.hits.get(key) ?? []).filter((time) => time > current - this.windowMs);
    if (recent.length >= this.limit) {
      throw new AppError(429, "rate_limited", "ส่งคำขอเร็วเกินไป กรุณารอสักครู่");
    }
    recent.push(current);
    this.hits.set(key, recent);
    if (this.hits.size > 5_000) this.#prune(current);
  }

  #prune(current) {
    for (const [key, times] of this.hits) {
      if (!times.some((time) => time > current - this.windowMs)) this.hits.delete(key);
    }
  }
}

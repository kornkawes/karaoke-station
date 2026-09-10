import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../lib/errors.js";
import { toBase64Url } from "../lib/compat.js";

export const ROOM_TTL_MS = 10 * 60 * 60 * 1_000;
export const CONTROLLER_TTL_MS = 12 * 60 * 60 * 1_000;
// A room can stay available while somebody is connected, but an empty room
// with connected controllers should not sit on a TV forever without a song.
// The warning and close windows are deliberately short and exported so the
// server timer and deterministic store tests share one contract.
export const ROOM_IDLE_WARNING_MS = 5 * 60 * 1_000;
export const ROOM_IDLE_CLOSE_MS = 10 * 60 * 1_000;
const MAX_DATE_MS = 8.64e15;

const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Public room identifier. Short enough to read off a TV screen, but it is only an
 * identifier — never a credential. Every privileged action still needs a token.
 */
export function generateRoomId(length = 8) {
  const bytes = randomBytes(length);
  let id = "";
  for (let index = 0; index < length; index += 1) {
    id += ROOM_ID_ALPHABET[bytes[index] % ROOM_ID_ALPHABET.length];
  }
  return id;
}

export function generateToken() {
  return toBase64Url(randomBytes(32));
}

export function safeEqual(valueA, valueB) {
  const a = Buffer.from(String(valueA));
  const b = Buffer.from(String(valueB));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function defaultRoomState() {
  return {
    revision: 0,
    settings: {
      stationName: "KaraokeStation",
      language: "th",
      theme: "dark",
      autoplayNext: true,
      confirmPlayNow: true,
      defaultVolume: 75,
      defaultLyricsMode: "video",
      singleKeyShortcuts: true,
      allowDuplicate: true,
      lrclibEnabled: true,
      fairQueue: false
    },
    playback: {
      playing: true,
      volume: 75,
      muted: false
    },
    current: null,
    queue: [],
    history: [],
    lyrics: []
  };
}

function hasSelectedSong(room) {
  return Boolean(room?.state?.current) || (room?.state?.queue?.length ?? 0) > 0;
}

function clearIdleMarkers(room) {
  room.idleSinceAt = null;
  room.idleWarningAt = null;
}

function safeTimestamp(value, fallback = Date.now()) {
  const candidate = value instanceof Date ? value.getTime() : Number(value);
  if (Number.isFinite(candidate) && candidate >= 0 && candidate <= MAX_DATE_MS) return candidate;
  const backup = fallback instanceof Date ? fallback.getTime() : Number(fallback);
  if (Number.isFinite(backup) && backup >= 0 && backup <= MAX_DATE_MS) return backup;
  return Date.now();
}

function startIdleClock(room, at) {
  if (room.idleSinceAt === null || room.idleSinceAt === undefined) room.idleSinceAt = safeTimestamp(at);
  room.idleWarningAt = null;
}

/** Public, clock-derived idle state used by the Host to render a countdown. */
export function roomIdleView(room, now = Date.now()) {
  const connectedControllerCount = Number(room?.connectedControllerCount) || 0;
  if (connectedControllerCount <= 0 || hasSelectedSong(room) || room?.idleSinceAt === null || room?.idleSinceAt === undefined) {
    return {
      phase: "active",
      warning: false,
      idleSinceAt: null,
      warningAt: null,
      closesAt: null
    };
  }

  const idleSinceAt = Number(room.idleSinceAt);
  if (!Number.isFinite(idleSinceAt) || idleSinceAt < 0 || idleSinceAt > MAX_DATE_MS - ROOM_IDLE_CLOSE_MS) {
    return {
      phase: "active",
      warning: false,
      idleSinceAt: null,
      warningAt: null,
      closesAt: null
    };
  }
  const warningAt = idleSinceAt + ROOM_IDLE_WARNING_MS;
  const closesAt = idleSinceAt + ROOM_IDLE_CLOSE_MS;
  const warning = safeTimestamp(now) >= warningAt;
  return {
    phase: warning ? "warning" : "idle",
    warning,
    idleSinceAt: new Date(idleSinceAt).toISOString(),
    warningAt: new Date(warningAt).toISOString(),
    closesAt: new Date(closesAt).toISOString()
  };
}

/**
 * In-memory room store.
 *
 * Deliberately kept behind this narrow surface (`create`, `get`, `mutate`, `close`,
 * `touch`, `setConnectedControllerCount`, `recordActivity`, `sweep`, `sweepIdle`) so
 * a Redis/durable implementation can replace it without the
 * routes changing. See docs/adr/0001-hosted-platform.md.
 *
 * `mutate` serializes per room: a room's mutations form a chain, so revision checks
 * and the mutation they guard cannot interleave with another request's write.
 */
export class MemoryRoomStore {
  constructor({ roomTtlMs = ROOM_TTL_MS, maxRooms = 500, now = () => Date.now() } = {}) {
    this.roomTtlMs = roomTtlMs;
    this.maxRooms = maxRooms;
    this.now = now;
    this.rooms = new Map();
    this.chains = new Map();
  }

  create() {
    this.sweep();
    if (this.rooms.size >= this.maxRooms) {
      throw new AppError(503, "room_capacity", "ห้องเต็มชั่วคราว กรุณาลองใหม่ภายหลัง");
    }
    let roomId = generateRoomId();
    while (this.rooms.has(roomId)) roomId = generateRoomId();
    const createdAt = this.now();
    const room = {
      roomId,
      hostToken: generateToken(),
      joinToken: generateToken(),
      createdAt,
      expiresAt: createdAt + this.roomTtlMs,
      lastSeenAt: createdAt,
      lastActivityAt: createdAt,
      connectedControllerCount: 0,
      idleSinceAt: null,
      idleWarningAt: null,
      controllers: new Map(),
      state: defaultRoomState()
    };
    this.rooms.set(roomId, room);
    return room;
  }

  /** Returns the live room record, or undefined when missing/expired. */
  get(roomId) {
    if (typeof roomId !== "string" || !roomId) return undefined;
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    if (room.expiresAt <= this.now()) {
      this.#drop(roomId);
      return undefined;
    }
    return room;
  }

  require(roomId) {
    const room = this.get(roomId);
    if (!room) {
      throw new AppError(404, "room_not_found", "ไม่พบห้องนี้ หรือห้องหมดอายุแล้ว");
    }
    return room;
  }

  /** Extends the sliding TTL. Called on any authenticated activity. */
  touch(roomId) {
    const room = this.get(roomId);
    if (!room) return undefined;
    room.lastSeenAt = this.now();
    room.expiresAt = room.lastSeenAt + this.roomTtlMs;
    return room;
  }

  /** Records a live controller socket count without extending controller TTLs. */
  setConnectedControllerCount(roomId, count, at = this.now()) {
    const room = this.get(roomId);
    if (!room) return undefined;
    const numeric = Number(count);
    const next = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    const timestamp = safeTimestamp(at, this.now());
    const previous = Number(room.connectedControllerCount) || 0;
    room.connectedControllerCount = next;
    if (next <= 0 || hasSelectedSong(room)) {
      clearIdleMarkers(room);
    } else if (previous <= 0) {
      // Start the idle window when the first live controller arrives, rather
      // than counting time spent showing the QR before anyone joined.
      room.idleSinceAt = timestamp;
      room.idleWarningAt = null;
    } else if (room.idleSinceAt === null || room.idleSinceAt === undefined) {
      startIdleClock(room, timestamp);
    }
    return room;
  }

  /** Marks a successful room interaction as meaningful activity. */
  recordActivity(roomId, at = this.now()) {
    const room = this.get(roomId);
    if (!room) return undefined;
    const timestamp = safeTimestamp(at, this.now());
    room.lastActivityAt = timestamp;
    if ((Number(room.connectedControllerCount) || 0) > 0 && !hasSelectedSong(room)) {
      room.idleSinceAt = timestamp;
      room.idleWarningAt = null;
    } else {
      clearIdleMarkers(room);
    }
    return room;
  }

  /**
   * Evaluates the controller-idle policy. The caller emits the returned events
   * so the store stays transport-agnostic and remains easy to replace.
   */
  sweepIdle(at = this.now()) {
    const timestamp = safeTimestamp(at, this.now());
    const warnings = [];
    const expired = [];
    for (const [roomId, room] of this.rooms) {
      const connected = Number(room.connectedControllerCount) || 0;
      if (connected <= 0 || hasSelectedSong(room)) {
        clearIdleMarkers(room);
        continue;
      }
      if (room.idleSinceAt === null || room.idleSinceAt === undefined) startIdleClock(room, timestamp);
      const idleSinceAt = Number(room.idleSinceAt);
      if (!Number.isFinite(idleSinceAt) || idleSinceAt < 0 || idleSinceAt > MAX_DATE_MS - ROOM_IDLE_CLOSE_MS) {
        // A malformed persisted marker must never wedge the room in an
        // unobservable idle state. Restart the clock from the validated sweep
        // timestamp and let a later sweep evaluate it normally.
        room.idleSinceAt = timestamp;
        room.idleWarningAt = null;
        continue;
      }
      const closesAt = idleSinceAt + ROOM_IDLE_CLOSE_MS;
      if (timestamp >= closesAt) {
        this.#drop(roomId);
        expired.push({ roomId, idleSinceAt, closesAt });
        continue;
      }
      if (timestamp >= idleSinceAt + ROOM_IDLE_WARNING_MS && !room.idleWarningAt) {
        room.idleWarningAt = timestamp;
        warnings.push({
          roomId,
          idleSinceAt,
          closesAt,
          warningAt: idleSinceAt + ROOM_IDLE_WARNING_MS
        });
      }
    }
    return { warnings, expired };
  }

  /**
   * Serialized read-modify-write for one room. The mutator receives a draft of the
   * room state; returning normally commits it and bumps `revision`.
   */
  mutate(roomId, mutator) {
    const previous = this.chains.get(roomId) ?? Promise.resolve();
    const run = previous.then(() => this.#applyMutation(roomId, mutator), () => this.#applyMutation(roomId, mutator));
    this.chains.set(roomId, run.catch(() => {}));
    return run;
  }

  async #applyMutation(roomId, mutator) {
    const room = this.require(roomId);
    const draft = room.state;
    const result = await mutator(draft);
    draft.revision += 1;
    this.touch(roomId);
    this.recordActivity(roomId, this.now());
    return { state: draft, result, room };
  }

  close(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    this.#drop(roomId);
    return true;
  }

  /**
   * Rotates every credential in place. Existing host/controller tokens stop
   * validating immediately; callers are responsible for disconnecting sockets.
   */
  rotate(roomId) {
    const room = this.require(roomId);
    room.hostToken = generateToken();
    room.joinToken = generateToken();
    room.controllers.clear();
    room.connectedControllerCount = 0;
    clearIdleMarkers(room);
    this.touch(roomId);
    return room;
  }

  /** Removes expired rooms and expired controller sessions. Returns rooms removed. */
  sweep() {
    const now = this.now();
    let removed = 0;
    for (const [roomId, room] of this.rooms) {
      if (room.expiresAt <= now) {
        this.#drop(roomId);
        removed += 1;
        continue;
      }
      for (const [token, controller] of room.controllers) {
        if (controller.expiresAt <= now) room.controllers.delete(token);
      }
    }
    return removed;
  }

  size() {
    return this.rooms.size;
  }

  #drop(roomId) {
    this.rooms.delete(roomId);
    this.chains.delete(roomId);
  }
}

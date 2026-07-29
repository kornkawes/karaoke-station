import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../lib/errors.js";
import { toBase64Url } from "../lib/compat.js";

export const ROOM_TTL_MS = 10 * 60 * 60 * 1_000;
export const CONTROLLER_TTL_MS = 12 * 60 * 60 * 1_000;

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
      lrclibEnabled: true
    },
    current: null,
    queue: [],
    history: [],
    lyrics: []
  };
}

/**
 * In-memory room store.
 *
 * Deliberately kept behind this narrow surface (`create`, `get`, `mutate`, `close`,
 * `touch`, `sweep`) so a Redis/durable implementation can replace it without the
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

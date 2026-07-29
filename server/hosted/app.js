import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ZodError } from "zod";
import { AppError, asyncRoute } from "../lib/errors.js";
import {
  addToQueue,
  advanceQueue,
  playQueueItemNow,
  queueView,
  removeQueueItem,
  reorderQueue
} from "../lib/library.js";
import { LyricsService } from "../lib/lyrics.js";
import {
  lyricSchema,
  queueAddSchema,
  queueFailureSchema,
  reorderSchema,
  settingsPatchSchema,
  youtubeIdSchema
} from "../lib/schemas.js";
import { parseYouTubeInput, YouTubeService } from "../lib/youtube.js";
import { defaultFetch } from "../lib/compat.js";
import { MemoryRoomStore } from "./rooms.js";
import {
  requireController,
  requireHost,
  requireMember,
  TokenRateLimiter,
  joinRoom
} from "./auth.js";
import {
  joinRequestSchema,
  playNowSchema,
  revisionSchema,
  roomIdSchema
} from "./schemas.js";

const VERSION = "0.2.0";

function data(response, value, status = 200) {
  return response.status(status).json({ data: value });
}

/** Everything a controller or display is allowed to see about a room. */
export function roomView(room) {
  return {
    roomId: room.roomId,
    revision: room.state.revision,
    stationName: room.state.settings.stationName,
    current: room.state.current,
    queue: room.state.queue,
    expiresAt: new Date(room.expiresAt).toISOString()
  };
}

/** Adds host-only fields on top of the shared view. */
function hostRoomView(room, { joinPath }) {
  return {
    ...roomView(room),
    settings: room.state.settings,
    history: room.state.history,
    lyrics: room.state.lyrics,
    controllerCount: room.controllers.size,
    joinPath
  };
}

/**
 * Origin allowlist. In production this must be an exact list; there is no wildcard
 * path and no `Access-Control-Allow-Credentials` anywhere, because the browser
 * sends the bearer token explicitly rather than relying on cookies.
 */
export function parseAllowedOrigins(value = "") {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        const url = new URL(entry);
        return url.origin.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function isAllowedOrigin(request, allowedOrigins) {
  const origin = request.headers?.origin;
  // Same-origin browser requests and non-browser clients omit Origin entirely.
  if (origin === undefined || origin === null || origin === "") return true;
  if (typeof origin !== "string" || origin.includes(",")) return false;
  if (allowedOrigins.length === 0) return false;
  try {
    return allowedOrigins.includes(new URL(origin).origin.toLowerCase());
  } catch {
    return false;
  }
}

export async function createHostedApplication({
  env = process.env,
  fetchImpl = defaultFetch(),
  distDir = path.resolve("dist"),
  store = new MemoryRoomStore(),
  now = () => Date.now()
} = {}) {
  // RENDER_EXTERNAL_URL is injected by the host and is the service's own public URL,
  // so it is a safe last resort: it keeps the deployment same-origin rather than
  // falling back to an empty allowlist that would reject the app's own browser calls.
  const allowedOrigins = parseAllowedOrigins(
    env.ALLOWED_ORIGINS || env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || ""
  );
  const apiKey = String(env.YOUTUBE_API_KEY ?? "").trim();
  const youtube = new YouTubeService({
    fetchImpl,
    // The key never leaves the server: it is read here and only used to build the
    // upstream request. No route ever returns it, and no error surfaces it.
    getApiKey: () => apiKey
  });
  const lyrics = new LyricsService({ fetchImpl });
  const events = new EventEmitter();
  const app = express();
  const actionLimiter = new TokenRateLimiter({ limit: 30, windowMs: 60_000, now });

  app.disable("x-powered-by");
  // Never trust proxy headers by default: X-Forwarded-For would otherwise let a
  // client forge its own source IP and defeat every IP-based rate limit below.
  app.set("trust proxy", env.TRUSTED_PROXY ? Number(env.TRUSTED_PROXY) : false);
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "https://www.youtube.com", "https://s.ytimg.com"],
        frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
        imgSrc: ["'self'", "data:", "https://i.ytimg.com", "https://img.youtube.com"],
        connectSrc: ["'self'", "wss:", "https://www.googleapis.com", "https://lrclib.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'", "blob:"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 15_552_000, includeSubDomains: true }
  }));

  app.use("/api", (_request, response, next) => {
    // Room state and tokens must never sit in a browser or intermediary cache.
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    next();
  });

  app.use("/api", (request, _response, next) => {
    if (!isAllowedOrigin(request, allowedOrigins)) {
      return next(new AppError(403, "origin_not_allowed", "ไม่อนุญาตคำสั่งจากเว็บไซต์อื่น"));
    }
    next();
  });

  app.use("/api", rateLimit({
    windowMs: 15 * 60_000,
    limit: 1_000,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new AppError(429, "rate_limited", "มีคำขอมากเกินไป กรุณารอสักครู่"));
    }
  }));

  const createRoomLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new AppError(429, "create_room_rate_limited", "สร้างห้องบ่อยเกินไป กรุณารอสักครู่"));
    }
  });

  // Guessing a 256-bit join token is infeasible regardless, so this limit exists to
  // cap abuse volume, not to gate legitimate rejoins (phones reconnect often).
  const joinLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new AppError(429, "join_rate_limited", "เข้าห้องบ่อยเกินไป กรุณารอสักครู่"));
    }
  });

  const searchLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new AppError(429, "search_rate_limited", "ค้นหาบ่อยเกินไป กรุณารอสักครู่"));
    }
  });

  app.use(express.json({ limit: "64kb", strict: true }));

  app.use("/api", (request, _response, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
    if (!request.is("application/json")) {
      return next(new AppError(415, "json_required", "คำสั่งนี้รองรับเฉพาะ application/json"));
    }
    next();
  });

  function requireApiKey() {
    if (!apiKey) {
      // Deliberately says nothing about configuration internals.
      throw new AppError(503, "search_unavailable", "ระบบค้นหายังไม่พร้อมใช้งาน");
    }
  }

  function emitRoom(room, eventName = "room:changed") {
    events.emit(eventName, { roomId: room.roomId, view: roomView(room) });
  }

  function emitAction(room, { actor, action, track }) {
    const payload = {
      roomId: room.roomId,
      actor,
      action,
      track: track ?? null,
      revision: room.state.revision,
      timestamp: new Date(now()).toISOString()
    };
    events.emit("room:action", payload);
    return payload;
  }

  function assertRevision(draft, revision) {
    if (draft.revision !== revision) {
      throw new AppError(409, "revision_conflict", "คิวมีการเปลี่ยนแปลง กรุณาโหลดคิวล่าสุด", {
        expectedRevision: draft.revision
      });
    }
  }

  function joinPathFor(room) {
    return `/party#room=${encodeURIComponent(room.roomId)}&join=${encodeURIComponent(room.joinToken)}`;
  }

  app.get("/api/v1/health", (_request, response) => {
    data(response, {
      status: "ok",
      version: VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date(now()).toISOString()
    });
  });

  // ---- Room lifecycle (host) ------------------------------------------------

  app.post("/api/v1/rooms", createRoomLimiter, (_request, response, next) => {
    try {
      const room = store.create();
      data(response, {
        roomId: room.roomId,
        hostToken: room.hostToken,
        joinToken: room.joinToken,
        joinPath: joinPathFor(room),
        expiresAt: new Date(room.expiresAt).toISOString(),
        searchConfigured: Boolean(apiKey)
      }, 201);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/rooms/:roomId", requireHost(store), (request, response) => {
    data(response, hostRoomView(request.room, { joinPath: joinPathFor(request.room) }));
  });

  app.delete("/api/v1/rooms/:roomId", requireHost(store), (request, response) => {
    const roomId = request.room.roomId;
    store.close(roomId);
    events.emit("room:closed", { roomId });
    data(response, { roomId, closed: true });
  });

  app.post("/api/v1/rooms/:roomId/rotate", requireHost(store), (request, response) => {
    const room = store.rotate(request.room.roomId);
    events.emit("room:rotated", { roomId: room.roomId });
    data(response, {
      roomId: room.roomId,
      hostToken: room.hostToken,
      joinToken: room.joinToken,
      joinPath: joinPathFor(room),
      expiresAt: new Date(room.expiresAt).toISOString()
    });
  });

  app.patch("/api/v1/rooms/:roomId/settings", requireHost(store), asyncRoute(async (request, response) => {
    const patch = settingsPatchSchema.parse(request.body);
    const mutation = await store.mutate(request.room.roomId, (draft) => {
      Object.assign(draft.settings, patch);
      return draft.settings;
    });
    emitRoom(mutation.room, "room:changed");
    data(response, { revision: mutation.state.revision, settings: mutation.result });
  }));

  // ---- Join (public, join token only) ---------------------------------------

  app.post("/api/v1/rooms/:roomId/join", joinLimiter, (request, response, next) => {
    try {
      const roomId = roomIdSchema.parse(request.params.roomId);
      const input = joinRequestSchema.parse(request.body);
      const room = store.require(roomId);
      const session = joinRoom(room, input, { now: now() });
      store.touch(roomId);
      events.emit("room:presence", { roomId, controllerCount: room.controllers.size });
      data(response, { ...session, searchConfigured: Boolean(apiKey) }, 201);
    } catch (error) {
      next(error);
    }
  });

  // ---- Room reads (host or controller) --------------------------------------

  app.get(
    "/api/v1/rooms/:roomId/queue",
    requireMember(store, { rateLimiter: actionLimiter }),
    (request, response) => {
      data(response, roomView(request.room));
    }
  );

  // ---- Search + suggestions (members only, so the key is never a public proxy) ---

  app.get(
    "/api/v1/rooms/:roomId/search",
    requireMember(store, { rateLimiter: actionLimiter }),
    searchLimiter,
    asyncRoute(async (request, response) => {
      requireApiKey();
      const result = await youtube.search({
        query: request.query.q,
        mode: request.query.mode ?? "both",
        maxResults: request.query.limit ?? 12
      });
      data(response, result);
    })
  );

  app.post(
    "/api/v1/rooms/:roomId/youtube/parse",
    requireMember(store, { rateLimiter: actionLimiter }),
    (request, response, next) => {
      try {
        data(response, parseYouTubeInput(request.body?.input));
      } catch (error) {
        next(error);
      }
    }
  );

  // ---- Queue mutations (host or controller share the same permissions) -------

  app.post(
    "/api/v1/rooms/:roomId/queue",
    requireMember(store, { rateLimiter: actionLimiter }),
    asyncRoute(async (request, response) => {
      const input = queueAddSchema.parse(request.body);
      const actorName = request.actor.role === "host" ? "Host" : request.actor.displayName;
      const mutation = await store.mutate(request.room.roomId, (draft) => addToQueue(draft, input.track, {
        playNow: request.actor.role === "host" ? input.playNow : false,
        allowDuplicate: input.allowDuplicate,
        requestedBy: actorName
      }));
      emitRoom(mutation.room, "room:changed");
      const action = emitAction(mutation.room, {
        actor: actorName,
        action: "add",
        track: mutation.result
      });
      data(response, {
        revision: mutation.state.revision,
        item: mutation.result,
        action,
        queue: queueView(mutation.state)
      }, 201);
    })
  );

  app.delete(
    "/api/v1/rooms/:roomId/queue/:itemId",
    requireMember(store, { rateLimiter: actionLimiter }),
    asyncRoute(async (request, response) => {
      const input = revisionSchema.parse(request.body ?? {});
      const mutation = await store.mutate(request.room.roomId, (draft) => {
        if (input.revision !== undefined) assertRevision(draft, input.revision);
        return removeQueueItem(draft, request.params.itemId);
      });
      const removed = mutation.result.removed ?? mutation.result.previous;
      emitRoom(mutation.room, "room:changed");
      const action = emitAction(mutation.room, {
        actor: request.actor.displayName ?? "Host",
        action: "remove",
        track: removed
      });
      data(response, {
        revision: mutation.state.revision,
        ...mutation.result,
        action,
        queue: queueView(mutation.state)
      });
    })
  );

  app.patch(
    "/api/v1/rooms/:roomId/queue/reorder",
    requireMember(store, { rateLimiter: actionLimiter }),
    asyncRoute(async (request, response) => {
      const input = reorderSchema.parse(request.body);
      if (input.revision === undefined) {
        throw new AppError(400, "revision_required", "ต้องส่ง revision ล่าสุดของคิว");
      }
      const mutation = await store.mutate(request.room.roomId, (draft) => {
        assertRevision(draft, input.revision);
        return reorderQueue(draft, input.itemId, input.toIndex);
      });
      emitRoom(mutation.room, "room:changed");
      const action = emitAction(mutation.room, {
        actor: request.actor.displayName ?? "Host",
        action: "reorder",
        track: mutation.result
      });
      data(response, {
        revision: mutation.state.revision,
        item: mutation.result,
        action,
        queue: queueView(mutation.state)
      });
    })
  );

  app.post(
    "/api/v1/rooms/:roomId/queue/skip",
    requireMember(store, { rateLimiter: actionLimiter }),
    asyncRoute(async (request, response) => {
      const input = revisionSchema.parse(request.body ?? {});
      const mutation = await store.mutate(request.room.roomId, (draft) => {
        if (input.revision !== undefined) assertRevision(draft, input.revision);
        if (!draft.current) {
          throw new AppError(409, "queue_has_no_current", "ไม่มีเพลงที่กำลังเล่นให้ข้าม");
        }
        return advanceQueue(draft, { outcome: "skipped" });
      });
      emitRoom(mutation.room, "room:changed");
      const action = emitAction(mutation.room, {
        actor: request.actor.displayName ?? "Host",
        action: "skip",
        track: mutation.result.previous
      });
      data(response, {
        revision: mutation.state.revision,
        ...mutation.result,
        action,
        queue: queueView(mutation.state)
      });
    })
  );

  app.post(
    "/api/v1/rooms/:roomId/queue/play-now",
    requireMember(store, { rateLimiter: actionLimiter }),
    asyncRoute(async (request, response) => {
      const input = playNowSchema.parse(request.body);
      const mutation = await store.mutate(request.room.roomId, (draft) => {
        assertRevision(draft, input.revision);
        return playQueueItemNow(draft, input.itemId);
      });
      emitRoom(mutation.room, "room:changed");
      const action = emitAction(mutation.room, {
        actor: request.actor.displayName ?? "Host",
        action: "play_now",
        track: mutation.result.current
      });
      data(response, {
        revision: mutation.state.revision,
        ...mutation.result,
        action,
        queue: queueView(mutation.state)
      });
    })
  );

  // ---- Playback advance (host/display only) ---------------------------------

  app.post(
    "/api/v1/rooms/:roomId/queue/advance",
    requireHost(store),
    asyncRoute(async (request, response) => {
      const input = revisionSchema.parse(request.body ?? {});
      const mutation = await store.mutate(request.room.roomId, (draft) => {
        // The display advances on track end. A stale revision here means another
        // client already advanced, so reject rather than double-skip a song.
        if (input.revision !== undefined) assertRevision(draft, input.revision);
        return advanceQueue(draft);
      });
      emitRoom(mutation.room, "room:changed");
      data(response, {
        revision: mutation.state.revision,
        ...mutation.result,
        queue: queueView(mutation.state)
      });
    })
  );

  app.post(
    "/api/v1/rooms/:roomId/queue/current/failure",
    requireHost(store),
    asyncRoute(async (request, response) => {
      const input = queueFailureSchema.parse(request.body);
      const mutation = await store.mutate(request.room.roomId, (draft) => advanceQueue(draft, {
        outcome: "failed",
        failureReason: { reason: input.reason, message: input.message ?? "" }
      }));
      emitRoom(mutation.room, "room:changed");
      data(response, {
        revision: mutation.state.revision,
        ...mutation.result,
        queue: queueView(mutation.state)
      });
    })
  );

  // ---- Lyrics (host only: display-side feature) -----------------------------

  app.get("/api/v1/rooms/:roomId/lyrics/:videoId", requireHost(store), (request, response, next) => {
    try {
      const videoId = youtubeIdSchema.parse(request.params.videoId);
      data(response, {
        revision: request.room.state.revision,
        item: request.room.state.lyrics.find((item) => item.videoId === videoId) ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/v1/rooms/:roomId/lyrics/:videoId", requireHost(store), asyncRoute(async (request, response) => {
    const lyric = lyricSchema.parse({ ...request.body, videoId: request.params.videoId });
    const mutation = await store.mutate(request.room.roomId, (draft) => {
      const item = { ...lyric, updatedAt: new Date(now()).toISOString() };
      const index = draft.lyrics.findIndex((entry) => entry.videoId === lyric.videoId);
      if (index >= 0) draft.lyrics[index] = item;
      else draft.lyrics.push(item);
      return item;
    });
    data(response, { revision: mutation.state.revision, item: mutation.result });
  }));

  app.get("/api/v1/rooms/:roomId/lyrics-search", requireHost(store), asyncRoute(async (request, response) => {
    if (!request.room.state.settings.lrclibEnabled) {
      throw new AppError(403, "lrclib_disabled", "ต้องเปิด LRCLIB ก่อนใช้งาน");
    }
    data(response, {
      provider: "lrclib",
      results: await lyrics.search({
        trackName: request.query.track,
        artistName: request.query.artist,
        albumName: request.query.album
      })
    });
  }));

  // ---- Static frontend ------------------------------------------------------

  if (existsSync(distDir)) {
    app.use(express.static(distDir, {
      index: false,
      maxAge: "1h",
      setHeaders(response, filePath) {
        if (filePath.endsWith("sw.js") || filePath.endsWith("manifest.webmanifest")) {
          response.setHeader("Cache-Control", "no-cache");
        }
      }
    }));
    app.get("*", (request, response, next) => {
      if (request.path.startsWith("/api/") || request.path.startsWith("/socket.io/")) return next();
      response.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.use((_request, _response, next) => {
    next(new AppError(404, "not_found", "ไม่พบเส้นทางที่เรียก"));
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof ZodError) {
      return response.status(400).json({
        error: {
          code: "validation_error",
          message: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        }
      });
    }
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return response.status(400).json({
        error: { code: "invalid_json", message: "JSON ไม่ถูกต้อง" }
      });
    }
    // body-parser rejections (oversized entity, bad charset) carry their own status.
    // Without this they fall through to 500 and read as a server fault.
    if (error?.type === "entity.too.large") {
      return response.status(413).json({
        error: { code: "payload_too_large", message: "ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป" }
      });
    }
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : "internal_error";
    const message = error instanceof AppError ? error.message : "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์";
    // Only AppError messages are safe to echo; anything else could carry upstream
    // detail (including the API key inside a URL) so it is logged, not returned.
    if (status >= 500 && !(error instanceof AppError)) console.error(error);
    return response.status(status).json({
      error: {
        code,
        message,
        ...(error?.details ? { details: error.details } : {})
      }
    });
  });

  return {
    app,
    store,
    events,
    services: { youtube, lyrics },
    searchConfigured: Boolean(apiKey),
    allowedOrigins,
    roomView
  };
}

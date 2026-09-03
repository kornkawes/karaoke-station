import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ZodError } from "zod";
import { AppError, asyncRoute } from "./lib/errors.js";
import {
  addToQueue,
  advanceQueue,
  playQueueItemNow,
  publicMutationResult,
  publicTrack,
  queueView,
  removeQueueItem,
  reorderQueue
} from "./lib/library.js";
import { LyricsService } from "./lib/lyrics.js";
import {
  favoriteSchema,
  fairQueuePatchSchema,
  generatePartyPin,
  lyricSchema,
  partyJoinSchema,
  partyPlayNowSchema,
  partyRevisionSchema,
  queueAddSchema,
  queueFailureSchema,
  reorderSchema,
  secretPatchSchema,
  settingsPatchSchema,
  youtubeIdSchema
} from "./lib/schemas.js";
import { JsonRepository } from "./lib/store.js";
import { SuggestionService } from "./lib/suggestions.js";
import { parseYouTubeInput, YouTubeService } from "./lib/youtube.js";
import {
  isSameOriginRequest,
  PartySessions,
  partyAuth,
  requireLoopback
} from "./middleware/access.js";
import { defaultFetch } from "./lib/compat.js";

const VERSION = "0.1.0";

function data(response, value, status = 200) {
  return response.status(status).json({ data: value });
}

function sameOriginMutation(request, _response, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
  if (!request.is("application/json")) {
    return next(new AppError(415, "json_required", "คำสั่งนี้รองรับเฉพาะ application/json"));
  }
  if (!isSameOriginRequest(request)) {
    return next(new AppError(403, "origin_not_allowed", "ไม่อนุญาตคำสั่งจากเว็บไซต์อื่น"));
  }
  next();
}

function publicPartyView(state) {
  return {
    enabled: state.settings.partyEnabled,
    stationName: state.settings.stationName,
    settings: { fairQueue: Boolean(state.settings.fairQueue) },
    revision: state.revision,
    current: publicTrack(state.current),
    next: state.queue.map(publicTrack)
  };
}

function hostStateView(state) {
  return {
    revision: state.revision,
    settings: state.settings,
    current: publicTrack(state.current),
    queue: state.queue.map(publicTrack),
    favorites: state.favorites,
    history: state.history,
    lyrics: state.lyrics
  };
}

export async function createApplication({
  dataDir = path.resolve("data"),
  env = process.env,
  fetchImpl = defaultFetch(),
  distDir = path.resolve("dist"),
  hostPort = Number(env.PORT) || 4173
} = {}) {
  const repository = await new JsonRepository({
    dataDir,
    envApiKey: env.YOUTUBE_API_KEY ?? ""
  }).init();
  await repository.mutateSecrets((draft) => {
    draft.partyPin = generatePartyPin();
    draft.partyPinExpiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
  });
  const youtube = new YouTubeService({
    fetchImpl,
    getApiKey: () => repository.getYoutubeApiKey()
  });
  const lyrics = new LyricsService({ fetchImpl });
  const partySessions = new PartySessions({ repository });
  const suggestions = new SuggestionService({ getState: () => repository.snapshot() });
  const events = new EventEmitter();
  const app = express();
  app.locals.hostPort = hostPort;
  const partyJoinLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new AppError(
        429,
        "party_join_rate_limited",
        "ลองใส่รหัสปาร์ตี้หลายครั้งเกินไป กรุณารอ 15 นาที"
      ));
    }
  });

  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.set("query parser", "simple");
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
        connectSrc: [
          "'self'",
          "ws:",
          "wss:",
          "https://www.googleapis.com",
          "https://lrclib.net"
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        workerSrc: ["'self'", "blob:"],
        manifestSrc: ["'self'"],
        upgradeInsecureRequests: null
      }
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }
  }));
  app.use((request, response, next) => {
    if (request.socket.localPort !== app.locals.hostPort) return next();
    return requireLoopback(request, response, next);
  });
  app.use(rateLimit({
    windowMs: 15 * 60_000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }));
  app.use(express.json({ limit: "128kb", strict: true }));
  app.use(sameOriginMutation);

  function emitState(state, eventName = "state:changed") {
    events.emit(eventName, hostStateView(state));
    events.emit("party:changed", publicPartyView(state));
  }

  function partyHostView() {
    const state = repository.snapshot();
    if (!state.settings.partyEnabled) {
      return {
        enabled: false,
        sessionId: null,
        pin: null,
        pinExpiresAt: null,
        joinPath: null,
        urls: []
      };
    }
    const joinToken = partySessions.getJoinToken();
    const fragment = `#join=${encodeURIComponent(joinToken)}`;
    return {
      enabled: true,
      sessionId: partySessions.sessionInfo().sessionId,
      pin: repository.getPartyPin(),
      pinExpiresAt: repository.secretStatus().partyPinExpiresAt,
      joinPath: `/party${fragment}`,
      urls: (app.locals.partyBaseUrls ?? []).map((baseUrl) => `${baseUrl}/party${fragment}`)
    };
  }

  function assertRevision(draft, revision) {
    if (draft.revision !== revision) {
      throw new AppError(409, "revision_conflict", "คิวมีการเปลี่ยนแปลง กรุณาโหลดคิวล่าสุด", {
        expectedRevision: draft.revision
      });
    }
  }

  function emitPartyAction({ actor, action, track, state }) {
    const payload = {
      actor,
      action,
      track: track ?? null,
      revision: state.revision,
      timestamp: new Date().toISOString()
    };
    events.emit("party:action", payload);
    return payload;
  }

  async function rotatePartySession() {
    const mutation = await repository.mutateSecrets((draft) => {
      draft.partyPin = generatePartyPin();
      draft.partyPinExpiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
      return { pin: draft.partyPin, pinExpiresAt: draft.partyPinExpiresAt };
    });
    partySessions.rotateLaunchSession();
    events.emit("party:rotated");
    return { ...mutation.result, ...partySessions.sessionInfo() };
  }

  app.get("/api/v1/health", (_request, response) => {
    data(response, {
      status: "ok",
      version: VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  app.get("/api/v1/config", requireLoopback, (_request, response) => {
    const state = repository.snapshot();
    data(response, {
      version: VERSION,
      settings: state.settings,
      youtube: {
        configured: repository.secretStatus().youtubeConfigured,
        key: null
      },
      party: {
        enabled: state.settings.partyEnabled,
        pinExpiresAt: repository.secretStatus().partyPinExpiresAt
      }
    });
  });

  app.get("/api/v1/state", requireLoopback, (_request, response) => {
    data(response, hostStateView(repository.snapshot()));
  });

  app.post("/api/v1/youtube/parse", requireLoopback, (request, response, next) => {
    try {
      data(response, parseYouTubeInput(request.body?.input));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/search", requireLoopback, asyncRoute(async (request, response) => {
    const result = await youtube.search({
      query: request.query.q,
      mode: request.query.mode ?? "both",
      maxResults: request.query.limit ?? 12
    });
    suggestions.remember(result.query);
    data(response, result);
  }));

  app.get("/api/v1/suggestions", requireLoopback, (request, response, next) => {
    try {
      data(response, suggestions.list({
        query: request.query.q ?? "",
        limit: request.query.limit ?? 8
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/queue", requireLoopback, (_request, response) => {
    data(response, queueView(repository.snapshot()));
  });

  app.post("/api/v1/queue", requireLoopback, asyncRoute(async (request, response) => {
    const input = queueAddSchema.parse(request.body);
    const mutation = await repository.mutate((draft) => addToQueue(draft, input.track, {
      playNow: input.playNow,
      allowDuplicate: input.allowDuplicate,
      requestedBy: "Host",
      requesterKey: "host"
    }));
    emitState(mutation.state, "queue:changed");
    data(response, { revision: mutation.state.revision, item: publicTrack(mutation.result), queue: queueView(mutation.state) }, 201);
  }));

  app.patch("/api/v1/queue/reorder", requireLoopback, asyncRoute(async (request, response) => {
    const input = reorderSchema.parse(request.body);
    const mutation = await repository.mutate((draft) => {
      if (input.revision !== undefined) assertRevision(draft, input.revision);
      return reorderQueue(draft, input.itemId, input.toIndex);
    });
    emitState(mutation.state, "queue:changed");
    data(response, { revision: mutation.state.revision, item: publicTrack(mutation.result), queue: queueView(mutation.state) });
  }));

  app.delete("/api/v1/queue/:itemId", requireLoopback, asyncRoute(async (request, response) => {
    const mutation = await repository.mutate((draft) => removeQueueItem(draft, request.params.itemId));
    emitState(mutation.state, "queue:changed");
    data(response, { revision: mutation.state.revision, ...publicMutationResult(mutation.result), queue: queueView(mutation.state) });
  }));

  app.post("/api/v1/queue/advance", requireLoopback, asyncRoute(async (request, response) => {
    const mutation = await repository.mutate((draft) => advanceQueue(draft));
    emitState(mutation.state, "queue:changed");
    data(response, { revision: mutation.state.revision, ...publicMutationResult(mutation.result), queue: queueView(mutation.state) });
  }));

  app.post("/api/v1/queue/current/failure", requireLoopback, asyncRoute(async (request, response) => {
    const input = queueFailureSchema.parse(request.body);
    const mutation = await repository.mutate((draft) => advanceQueue(draft, {
      outcome: "failed",
      failureReason: { reason: input.reason, message: input.message ?? "" }
    }));
    emitState(mutation.state, "queue:changed");
    data(response, { revision: mutation.state.revision, ...publicMutationResult(mutation.result), queue: queueView(mutation.state) });
  }));

  app.delete("/api/v1/queue", requireLoopback, asyncRoute(async (_request, response) => {
    const mutation = await repository.mutate((draft) => {
      const removedCount = draft.queue.length + (draft.current ? 1 : 0);
      draft.current = null;
      draft.queue = [];
      return { removedCount };
    });
    emitState(mutation.state, "queue:changed");
    data(response, { revision: mutation.state.revision, ...mutation.result });
  }));

  app.get("/api/v1/favorites", requireLoopback, (_request, response) => {
    const state = repository.snapshot();
    data(response, { revision: state.revision, items: state.favorites });
  });

  app.post("/api/v1/favorites", requireLoopback, asyncRoute(async (request, response) => {
    const track = favoriteSchema.parse(request.body);
    const mutation = await repository.mutate((draft) => {
      const existing = draft.favorites.find((item) => item.videoId === track.videoId);
      if (existing) return existing;
      if (draft.favorites.length >= 1_000) {
        throw new AppError(409, "favorites_full", "รายการโปรดเต็มแล้ว");
      }
      const item = { ...track, addedAt: new Date().toISOString() };
      draft.favorites.unshift(item);
      return item;
    });
    emitState(mutation.state, "library:changed");
    data(response, { revision: mutation.state.revision, item: mutation.result }, 201);
  }));

  app.delete("/api/v1/favorites/:videoId", requireLoopback, asyncRoute(async (request, response) => {
    const videoId = youtubeIdSchema.parse(request.params.videoId);
    const mutation = await repository.mutate((draft) => {
      const before = draft.favorites.length;
      draft.favorites = draft.favorites.filter((item) => item.videoId !== videoId);
      if (before === draft.favorites.length) {
        throw new AppError(404, "favorite_not_found", "ไม่พบเพลงในรายการโปรด");
      }
      return { videoId };
    });
    emitState(mutation.state, "library:changed");
    data(response, { revision: mutation.state.revision, ...mutation.result });
  }));

  app.get("/api/v1/history", requireLoopback, (request, response) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 1_000);
    const state = repository.snapshot();
    data(response, { revision: state.revision, items: state.history.slice(0, limit) });
  });

  app.delete("/api/v1/history", requireLoopback, asyncRoute(async (_request, response) => {
    const mutation = await repository.mutate((draft) => {
      const removedCount = draft.history.length;
      draft.history = [];
      return { removedCount };
    });
    emitState(mutation.state, "library:changed");
    data(response, { revision: mutation.state.revision, ...mutation.result });
  }));

  app.get("/api/v1/lyrics/:videoId", requireLoopback, (request, response, next) => {
    try {
      const videoId = youtubeIdSchema.parse(request.params.videoId);
      const state = repository.snapshot();
      data(response, {
        revision: state.revision,
        item: state.lyrics.find((item) => item.videoId === videoId) ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/v1/lyrics/:videoId", requireLoopback, asyncRoute(async (request, response) => {
    const lyric = lyricSchema.parse({ ...request.body, videoId: request.params.videoId });
    const mutation = await repository.mutate((draft) => {
      const item = { ...lyric, updatedAt: new Date().toISOString() };
      const index = draft.lyrics.findIndex((entry) => entry.videoId === lyric.videoId);
      if (index >= 0) draft.lyrics[index] = item;
      else draft.lyrics.push(item);
      return item;
    });
    emitState(mutation.state, "library:changed");
    data(response, { revision: mutation.state.revision, item: mutation.result });
  }));

  app.delete("/api/v1/lyrics/:videoId", requireLoopback, asyncRoute(async (request, response) => {
    const videoId = youtubeIdSchema.parse(request.params.videoId);
    const mutation = await repository.mutate((draft) => {
      const before = draft.lyrics.length;
      draft.lyrics = draft.lyrics.filter((item) => item.videoId !== videoId);
      if (before === draft.lyrics.length) {
        throw new AppError(404, "lyrics_not_found", "ไม่พบเนื้อร้องที่บันทึกไว้");
      }
      return { videoId };
    });
    emitState(mutation.state, "library:changed");
    data(response, { revision: mutation.state.revision, ...mutation.result });
  }));

  app.get("/api/v1/lyrics-search", requireLoopback, asyncRoute(async (request, response) => {
    if (!repository.snapshot().settings.lrclibEnabled) {
      throw new AppError(403, "lrclib_disabled", "ต้องเปิด LRCLIB ใน Settings ก่อนใช้งาน");
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

  app.get("/api/v1/settings", requireLoopback, (_request, response) => {
    const state = repository.snapshot();
    data(response, { revision: state.revision, settings: state.settings });
  });

  app.patch("/api/v1/settings", requireLoopback, asyncRoute(async (request, response) => {
    const patch = settingsPatchSchema.parse(request.body);
    const wasPartyEnabled = repository.snapshot().settings.partyEnabled;
    if (patch.partyEnabled === true && !wasPartyEnabled) {
      await rotatePartySession();
    }
    const mutation = await repository.mutate((draft) => {
      Object.assign(draft.settings, patch);
      return draft.settings;
    });
    if (patch.partyEnabled === false) partySessions.revokeAll();
    emitState(mutation.state, "settings:changed");
    data(response, { revision: mutation.state.revision, settings: mutation.result });
  }));

  app.put("/api/v1/settings/youtube-key", requireLoopback, asyncRoute(async (request, response) => {
    const input = secretPatchSchema.parse(request.body);
    const mutation = await repository.mutateSecrets((draft) => {
      draft.youtubeApiKey = input.youtubeApiKey;
      return { configured: Boolean(input.youtubeApiKey) };
    });
    data(response, {
      youtube: {
        configured: mutation.status.youtubeConfigured,
        key: null
      }
    });
  }));

  app.get("/api/v1/party", requireLoopback, (_request, response) => {
    data(response, partyHostView());
  });

  app.post("/api/v1/party/rotate", requireLoopback, asyncRoute(async (_request, response) => {
    if (!repository.snapshot().settings.partyEnabled) {
      throw new AppError(409, "party_not_enabled", "ต้องเปิด Party Mode ก่อนหมุนเซสชัน");
    }
    await rotatePartySession();
    data(response, partyHostView());
  }));

  app.post("/api/v1/party/session/start", requireLoopback, asyncRoute(async (_request, response) => {
    await rotatePartySession();
    let enabledState = null;
    if (!repository.snapshot().settings.partyEnabled) {
      const mutation = await repository.mutate((draft) => {
        draft.settings.partyEnabled = true;
        return draft.settings;
      });
      enabledState = mutation.state;
    }
    if (typeof app.locals.ensurePartyListener === "function") {
      try {
        await app.locals.ensurePartyListener();
      } catch {
        if (enabledState) {
          const rollback = await repository.mutate((draft) => {
            draft.settings.partyEnabled = false;
            return draft.settings;
          });
          emitState(rollback.state, "settings:changed");
        }
        throw new AppError(
          503,
          "party_listener_unavailable",
          "เปิด Party Mode บนเครือข่ายไม่สำเร็จ"
        );
      }
    } else {
      events.emit("party:listener:start");
    }
    if (enabledState) emitState(enabledState, "settings:changed");
    data(response, partyHostView());
  }));

  app.get("/api/v1/party/status", (_request, response) => {
    data(response, publicPartyView(repository.snapshot()));
  });

  app.post("/api/v1/party/join", partyJoinLimiter, asyncRoute(async (request, response) => {
    const input = partyJoinSchema.parse(request.body);
    data(response, partySessions.join(input), 201);
  }));

  const requireParty = partyAuth(partySessions);

  app.patch("/api/v1/party/settings", requireParty, asyncRoute(async (request, response) => {
    const patch = fairQueuePatchSchema.parse(request.body);
    const mutation = await repository.mutate((draft) => {
      draft.settings.fairQueue = patch.fairQueue;
      return { fairQueue: draft.settings.fairQueue };
    });
    emitState(mutation.state, "settings:changed");
    data(response, { revision: mutation.state.revision, settings: mutation.result });
  }));

  app.get("/api/v1/party/search", requireParty, asyncRoute(async (request, response) => {
    const result = await youtube.search({
      query: request.query.q,
      mode: request.query.mode ?? "both",
      maxResults: request.query.limit ?? 12
    });
    suggestions.remember(result.query);
    data(response, result);
  }));

  const requirePartyWithoutActionRate = partyAuth(partySessions, { rateLimit: false });
  app.get("/api/v1/party/suggestions", requirePartyWithoutActionRate, (request, response, next) => {
    try {
      data(response, suggestions.list({
        query: request.query.q ?? "",
        limit: request.query.limit ?? 8
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/party/queue", requireParty, asyncRoute(async (request, response) => {
    const input = queueAddSchema.parse({ ...request.body, playNow: false });
    const mutation = await repository.mutate((draft) => addToQueue(draft, input.track, {
      playNow: false,
      allowDuplicate: input.allowDuplicate,
      requestedBy: request.partySession.displayName,
      requesterKey: request.partySession.controllerId || request.partySession.displayName
    }));
    emitState(mutation.state, "queue:changed");
    const action = emitPartyAction({
      actor: request.partySession.displayName,
      action: "add",
      track: publicTrack(mutation.result),
      state: mutation.state
    });
    data(response, {
      revision: mutation.state.revision,
      item: publicTrack(mutation.result),
      action,
      queue: queueView(mutation.state),
      position: mutation.state.current?.id === mutation.result.id
        ? 0
        : mutation.state.queue.findIndex((item) => item.id === mutation.result.id) + 1
    }, 201);
  }));

  app.delete("/api/v1/party/queue/:itemId", requireParty, asyncRoute(async (request, response) => {
    const input = partyRevisionSchema.parse(request.body);
    const mutation = await repository.mutate((draft) => {
      assertRevision(draft, input.revision);
      return removeQueueItem(draft, request.params.itemId);
    });
    const removed = mutation.result.removed ?? mutation.result.previous;
    emitState(mutation.state, "queue:changed");
    const action = emitPartyAction({
      actor: request.partySession.displayName,
      action: "remove",
      track: publicTrack(removed),
      state: mutation.state
    });
    data(response, {
      revision: mutation.state.revision,
      ...publicMutationResult(mutation.result),
      action,
      queue: queueView(mutation.state)
    });
  }));

  app.patch("/api/v1/party/queue/reorder", requireParty, asyncRoute(async (request, response) => {
    const input = reorderSchema.parse(request.body);
    if (input.revision === undefined) {
      throw new AppError(400, "revision_required", "ต้องส่ง revision ล่าสุดของคิว");
    }
    const mutation = await repository.mutate((draft) => {
      assertRevision(draft, input.revision);
      return reorderQueue(draft, input.itemId, input.toIndex);
    });
    emitState(mutation.state, "queue:changed");
    const action = emitPartyAction({
      actor: request.partySession.displayName,
      action: "reorder",
      track: publicTrack(mutation.result),
      state: mutation.state
    });
    data(response, {
      revision: mutation.state.revision,
      item: publicTrack(mutation.result),
      action,
      queue: queueView(mutation.state)
    });
  }));

  app.post("/api/v1/party/queue/skip", requireParty, asyncRoute(async (request, response) => {
    const input = partyRevisionSchema.parse(request.body);
    const mutation = await repository.mutate((draft) => {
      assertRevision(draft, input.revision);
      if (!draft.current) {
        throw new AppError(409, "queue_has_no_current", "ไม่มีเพลงที่กำลังเล่นให้ข้าม");
      }
      return advanceQueue(draft, { outcome: "skipped" });
    });
    emitState(mutation.state, "queue:changed");
    const action = emitPartyAction({
      actor: request.partySession.displayName,
      action: "skip",
      track: publicTrack(mutation.result.previous),
      state: mutation.state
    });
    data(response, {
      revision: mutation.state.revision,
      ...publicMutationResult(mutation.result),
      action,
      queue: queueView(mutation.state)
    });
  }));

  app.post("/api/v1/party/queue/play-now", requireParty, asyncRoute(async (request, response) => {
    const input = partyPlayNowSchema.parse(request.body);
    const mutation = await repository.mutate((draft) => {
      assertRevision(draft, input.revision);
      return playQueueItemNow(draft, input.itemId);
    });
    emitState(mutation.state, "queue:changed");
    const action = emitPartyAction({
      actor: request.partySession.displayName,
      action: "play_now",
      track: publicTrack(mutation.result.current),
      state: mutation.state
    });
    data(response, {
      revision: mutation.state.revision,
      ...publicMutationResult(mutation.result),
      action,
      queue: queueView(mutation.state)
    });
  }));

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
    app.get("/{*splat}", (request, response, next) => {
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
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : "internal_error";
    const message = error instanceof AppError ? error.message : "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์";
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
    repository,
    events,
    partySessions,
    publicPartyView: () => publicPartyView(repository.snapshot()),
    services: { youtube, lyrics, suggestions }
  };
}

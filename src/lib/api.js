import { io } from "socket.io-client";

const API_ROOT = "/api/v1";

export class ApiError extends Error {
  constructor(message, { code = "request_failed", status = 0, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, { ...options, headers });
  } catch {
    throw new ApiError("เชื่อมต่อ KaraokeStation ไม่สำเร็จ", { code: "network_error" });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(body.error?.message || "คำขอไม่สำเร็จ", {
      code: body.error?.code,
      status: response.status,
      details: body.error?.details
    });
  }
  return body.data;
}

const query = (values) => {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  });
  return params.toString();
};

export const karaokeApi = {
  health: () => request("/health"),
  config: () => request("/config"),
  state: () => request("/state"),
  parseYouTube: (input) => request("/youtube/parse", { method: "POST", body: JSON.stringify({ input }) }),
  search: (searchText, mode = "both") => request(`/search?${query({ q: searchText, mode, limit: 30 })}`),
  suggestions: (searchText, token) => token
    ? request(`/party/suggestions?${query({ q: searchText, limit: 8 })}`, { headers: bearer(token) })
    : request(`/suggestions?${query({ q: searchText, limit: 8 })}`),

  queue: () => request("/queue"),
  addToQueue: (track, { playNow = false, allowDuplicate } = {}) =>
    request("/queue", { method: "POST", body: JSON.stringify({ track: apiTrack(track), playNow, allowDuplicate }) }),
  removeFromQueue: (id) => request(`/queue/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" }),
  clearQueue: () => request("/queue", { method: "DELETE", body: "{}" }),
  reorderQueue: (itemId, toIndex) =>
    request("/queue/reorder", { method: "PATCH", body: JSON.stringify({ itemId, toIndex }) }),
  advanceQueue: () => request("/queue/advance", { method: "POST", body: "{}" }),
  currentFailure: (reason, message) =>
    request("/queue/current/failure", { method: "POST", body: JSON.stringify({ reason, message }) }),

  favorites: () => request("/favorites"),
  addFavorite: (track) => request("/favorites", { method: "POST", body: JSON.stringify(apiTrack(track)) }),
  removeFavorite: (videoId) => request(`/favorites/${encodeURIComponent(videoId)}`, { method: "DELETE", body: "{}" }),
  history: (limit = 100) => request(`/history?${query({ limit })}`),
  clearHistory: () => request("/history", { method: "DELETE", body: "{}" }),

  lyrics: (videoId) => request(`/lyrics/${encodeURIComponent(videoId)}`),
  saveLyrics: (videoId, lyric) =>
    request(`/lyrics/${encodeURIComponent(videoId)}`, { method: "PUT", body: JSON.stringify(lyric) }),
  removeLyrics: (videoId) => request(`/lyrics/${encodeURIComponent(videoId)}`, { method: "DELETE", body: "{}" }),
  searchLyrics: (track, artist = "", album = "") =>
    request(`/lyrics-search?${query({ track, artist, album })}`),

  settings: () => request("/settings"),
  updateSettings: (patch) => request("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  saveYouTubeKey: (youtubeApiKey) =>
    request("/settings/youtube-key", { method: "PUT", body: JSON.stringify({ youtubeApiKey }) }),

  party: () => request("/party"),
  startPartySession: () => request("/party/session/start", { method: "POST", body: "{}" }),
  rotateParty: () => request("/party/session/start", { method: "POST", body: "{}" }),
  joinParty: (credential, displayName, credentialType = "pin") =>
    request("/party/join", { method: "POST", body: JSON.stringify({ displayName, [credentialType]: credential }) }),
  partyStatus: () => request("/party/status"),
  partySettings: (patch, token) => request("/party/settings", {
    method: "PATCH", headers: bearer(token), body: JSON.stringify(patch)
  }),
  partySearch: (searchText, mode = "both", token) =>
    request(`/party/search?${query({ q: searchText, mode, limit: 30 })}`, { headers: bearer(token) }),
  partyQueue: (track, token) =>
    request("/party/queue", { method: "POST", headers: bearer(token), body: JSON.stringify({ track: apiTrack(track) }) }),
  partyRemove: (itemId, token, revision) => request(`/party/queue/${encodeURIComponent(itemId)}`, {
    method: "DELETE", headers: bearer(token), body: JSON.stringify({ revision })
  }),
  partyReorder: (itemId, toIndex, token, revision) => request("/party/queue/reorder", {
    method: "PATCH", headers: bearer(token), body: JSON.stringify({ itemId, toIndex, revision })
  }),
  partySkip: (token, revision) => request("/party/queue/skip", {
    method: "POST", headers: bearer(token), body: JSON.stringify({ revision })
  }),
  partyPlayNow: (itemId, token, revision) => request("/party/queue/play-now", {
    method: "POST", headers: bearer(token), body: JSON.stringify({ itemId, revision })
  })
};

function bearer(token) {
  return { Authorization: `Bearer ${token || ""}` };
}

const CLASSIFICATION_TO_BADGE = {
  karaoke: "Karaoke",
  instrumental: "Instrumental",
  backing_track: "Backing Track"
};
const BADGE_TO_CLASSIFICATION = Object.fromEntries(
  Object.entries(CLASSIFICATION_TO_BADGE).map(([classification, badge]) => [badge, classification])
);

export function apiTrack(track) {
  const classification = CLASSIFICATION_TO_BADGE[track?.classification]
    ? track.classification
    : BADGE_TO_CLASSIFICATION[track?.badge] || null;
  const badge = classification ? CLASSIFICATION_TO_BADGE[classification] : null;
  return {
    videoId: track.videoId,
    title: track.title,
    channelTitle: track.channelTitle || "",
    ...(track.thumbnailUrl ? { thumbnailUrl: track.thumbnailUrl } : {}),
    ...(track.duration ? { duration: track.duration } : {}),
    ...(classification ? { classification } : {}),
    ...(badge ? { badge } : {})
  };
}

export function normalizeTrack(track) {
  if (!track) return null;
  return {
    ...track,
    videoId: track.videoId,
    queueId: track.id,
    channelTitle: track.channelTitle || "",
    thumbnailUrl: track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`
  };
}

export function normalizeQueue(payload) {
  const queue = payload?.queue || payload || {};
  if (Array.isArray(queue)) {
    return { revision: payload?.revision ?? 0, current: normalizeTrack(payload?.current), items: queue.map(normalizeTrack) };
  }
  return {
    revision: queue.revision ?? 0,
    current: normalizeTrack(queue.current),
    items: Array.isArray(queue.items) ? queue.items.map(normalizeTrack) : Array.isArray(queue.next) ? queue.next.map(normalizeTrack) : []
  };
}

export function connectStation(onEvent, { partyToken } = {}) {
  const socket = io({
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    ...(partyToken ? { auth: { token: partyToken } } : {})
  });
  socket.on("connect", () => onEvent({ type: "connection", connected: true }));
  socket.on("disconnect", (reason) => onEvent({ type: "connection", connected: false, error: reason }));
  socket.on("connect_error", (error) => onEvent({
    type: "connection",
    connected: false,
    error: error.data?.code || "socket_error"
  }));
  for (const eventName of ["state:snapshot", "queue:changed", "library:changed", "settings:changed"]) {
    socket.on(eventName, (state) => onEvent({ type: "host-state", eventName, state }));
  }
  socket.on("party:snapshot", (state) => onEvent({ type: "party-state", state }));
  socket.on("party:changed", (state) => onEvent({ type: "party-state", state }));
  socket.on("party:action", (action) => onEvent({ type: "party-action", action }));
  socket.on("guest:count", (value) => onEvent({ type: "guest-count", count: value.count }));
  return () => socket.disconnect();
}

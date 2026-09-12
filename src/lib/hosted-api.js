import { io } from "socket.io-client";
import { ApiError, apiTrack, normalizeQueue, normalizeTrack } from "./api";

const API_ROOT = "/api/v1";

export { ApiError, apiTrack, normalizeQueue, normalizeTrack };

/**
 * Session storage keys. Tokens live in sessionStorage, never localStorage: closing
 * the tab should end the session, and nothing should survive on a shared machine.
 */
export const HOST_STORAGE_KEY = "karaoke.hostSession";
export const CONTROLLER_STORAGE_KEY = "karaoke.controllerSession";

async function request(path, { token, method = "GET", body, ...options } = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (hasBody) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      method,
      headers,
      body: hasBody ? JSON.stringify(body ?? {}) : undefined
    });
  } catch {
    throw new ApiError("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ", { code: "network_error" });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload.error?.message || "คำขอไม่สำเร็จ", {
      code: payload.error?.code,
      status: response.status,
      details: payload.error?.details
    });
  }
  return payload.data;
}

const query = (values) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  }
  return params.toString();
};

const roomPath = (roomId, suffix = "") => `/rooms/${encodeURIComponent(roomId)}${suffix}`;

export const hostedApi = {
  health: () => request("/health"),

  createRoom: () => request("/rooms", { method: "POST" }),
  room: (roomId, token) => request(roomPath(roomId), { token }),
  closeRoom: (roomId, token) => request(roomPath(roomId), { method: "DELETE", token }),
  rotateRoom: (roomId, token) => request(roomPath(roomId, "/rotate"), { method: "POST", token }),
  updateSettings: (roomId, token, patch) =>
    request(roomPath(roomId, "/settings"), { method: "PATCH", token, body: patch }),
  updatePlayback: (roomId, token, patch) =>
    request(roomPath(roomId, "/playback"), { method: "PATCH", token, body: patch }),

  join: (roomId, joinToken, displayName) =>
    request(roomPath(roomId, "/join"), { method: "POST", body: { joinToken, displayName } }),

  queue: (roomId, token) => request(roomPath(roomId, "/queue"), { token }),
  search: (roomId, token, searchText, mode = "both", { limit = 30, pageToken } = {}) =>
    request(`${roomPath(roomId, "/search")}?${query({ q: searchText, mode, limit, pageToken })}`, { token }),
  catalogSuggestions: (roomId, token, searchText, { limit = 8 } = {}) =>
    request(`${roomPath(roomId, "/catalog/suggestions")}?${query({ q: searchText, limit })}`, { token }),
  addTrack: (roomId, token, track, { playNow = false, allowDuplicate } = {}) =>
    request(roomPath(roomId, "/queue"), {
      method: "POST",
      token,
      body: { track: apiTrack(track), playNow, allowDuplicate }
    }),
  removeTrack: (roomId, token, itemId, revision) =>
    request(roomPath(roomId, `/queue/${encodeURIComponent(itemId)}`), {
      method: "DELETE",
      token,
      body: { revision }
    }),
  reorder: (roomId, token, itemId, toIndex, revision) =>
    request(roomPath(roomId, "/queue/reorder"), {
      method: "PATCH",
      token,
      body: { itemId, toIndex, revision }
    }),
  skip: (roomId, token, revision) =>
    request(roomPath(roomId, "/queue/skip"), { method: "POST", token, body: { revision } }),
  complete: (roomId, token, revision) =>
    request(roomPath(roomId, "/queue/complete"), { method: "POST", token, body: { revision } }),
  playNow: (roomId, token, itemId, revision) =>
    request(roomPath(roomId, "/queue/play-now"), {
      method: "POST",
      token,
      body: { itemId, revision }
    }),
  advance: (roomId, token, revision) =>
    request(roomPath(roomId, "/queue/advance"), { method: "POST", token, body: { revision } }),
  currentFailure: (roomId, token, reason, message) =>
    request(roomPath(roomId, "/queue/current/failure"), {
      method: "POST",
      token,
      body: { reason, message }
    }),

  history: (roomId, token) => request(roomPath(roomId, "/history"), { token }),
  resolveYouTube: (roomId, token, input) =>
    request(roomPath(roomId, "/youtube/resolve"), { method: "POST", token, body: { input } }),

  lyrics: (roomId, token, videoId) =>
    request(roomPath(roomId, `/lyrics/${encodeURIComponent(videoId)}`), { token }),
  searchLyrics: (roomId, token, track, artist = "", album = "") =>
    request(`${roomPath(roomId, "/lyrics-search")}?${query({ track, artist, album })}`, { token })
};

/**
 * Reads the room id and join token from the URL fragment, then strips it.
 *
 * The fragment is used rather than the query string so the join token never reaches
 * the server in a request line and never lands in an access log or Referer header.
 */
export function consumeJoinFragment(locationLike = window.location, historyLike = window.history) {
  const params = new URLSearchParams(String(locationLike.hash || "").replace(/^#/, ""));
  const roomId = params.get("room") || "";
  const joinToken = params.get("join") || "";
  if (roomId || joinToken) {
    historyLike.replaceState(null, "", `${locationLike.pathname}${locationLike.search}`);
  }
  return { roomId, joinToken };
}

export function readSession(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.roomId || !parsed?.token) return null;
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
      sessionStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeSession(key, session) {
  try {
    sessionStorage.setItem(key, JSON.stringify(session));
  } catch {
    // Private-mode browsers can refuse storage; the session still works in memory.
  }
}

export function clearSession(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Absolute join URL for the QR code, built from the hosted origin. */
export function joinUrlFor(joinPath, origin = window.location.origin) {
  return `${origin}${joinPath}`;
}

/** Build a fresh controller invite URL from the room-scoped join credential. */
export function partyJoinUrlFor(roomId, joinToken, origin = window.location.origin) {
  if (!roomId || !joinToken) return "";
  const fragment = new URLSearchParams({ room: roomId, join: joinToken }).toString();
  return `${origin}/party#${fragment}`;
}

/**
 * Return a safe, absolute invite URL for a stored host session.
 *
 * `joinPath` is kept for compatibility with older sessions, but it is treated
 * as untrusted persisted data. Only the same-origin `/party` route is allowed;
 * malformed or external values fall back to a fresh fragment invite.
 */
export function sessionJoinUrlFor(session, origin = window.location.origin) {
  if (!session) return "";
  let baseOrigin;
  try {
    baseOrigin = new URL(origin).origin;
  } catch {
    return "";
  }

  if (session.joinPath) {
    try {
      const parsed = new URL(session.joinPath, baseOrigin);
      if (parsed.origin === baseOrigin && parsed.pathname === "/party" && parsed.search === "") {
        return parsed.toString();
      }
    } catch {
      // Fall through to the token-based URL when an old session is malformed.
    }
  }
  return partyJoinUrlFor(session.roomId, session.joinToken, baseOrigin);
}

export function isSessionRevokedError(codeOrMessage = "") {
  return /401|403|host_token_invalid|controller_session_expired|controller_auth_required|host_auth_required|room_not_found|room_rotated|room_closed|room_idle_timeout|session:expired/i
    .test(String(codeOrMessage));
}

/**
 * Connects to the room channel. All events are already room-scoped server-side, so
 * the client never has to filter by room id itself.
 */
export function connectRoom({ roomId, token }, onEvent) {
  const socket = io({
    auth: { roomId, token },
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000
  });

  socket.on("connect", () => {
    onEvent({ type: "connection", connected: true });
    // Ask for a fresh snapshot: on a reconnect the queue may have moved on.
    socket.emit("room:sync");
  });
  socket.on("disconnect", (reason) => onEvent({ type: "connection", connected: false, error: reason }));
  socket.on("connect_error", (error) => {
    const code = error.data?.code || "socket_error";
    onEvent({ type: "connection", connected: false, error: code });
    // A tab can be offline while the server expires the room. On its next
    // reconnect there is no room:revoked event to deliver, so promote the
    // authenticated handshake error to the same revocation transition.
    if (isSessionRevokedError(`${code} ${error.message || ""}`)) {
      onEvent({ type: "revoked", code });
    }
  });
  socket.on("room:snapshot", (view) => onEvent({ type: "room", view }));
  socket.on("room:changed", (view) => onEvent({ type: "room", view }));
  socket.on("room:action", (action) => onEvent({ type: "action", action }));
  socket.on("room:presence", (presence) => onEvent({
    type: "presence",
    // Older hosted servers only sent the total socket count. Keep that field
    // for compatibility and prefer the controller-only count when available.
    count: presence.count,
    controllerCount: presence.controllerCount,
    connectedControllerCount: presence.connectedControllerCount
  }));
  socket.on("room:idle-warning", (payload) => onEvent({
    type: "idle-warning",
    closesAt: payload.closesAt,
    warningAt: payload.warningAt
  }));
  socket.on("room:revoked", (payload) => onEvent({ type: "revoked", code: payload.code }));
  socket.on("session:expired", () => onEvent({ type: "revoked", code: "session_expired" }));

  return () => socket.disconnect();
}

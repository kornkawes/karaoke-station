import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  Copy,
  DoorOpen,
  GripVertical,
  History,
  ListMusic,
  LoaderCircle,
  Maximize2,
  Mic2,
  Pause,
  Play,
  Plus,
  QrCode,
  Search,
  Settings,
  Share2,
  SkipBack,
  SkipForward,
  Star,
  Trash2,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
  Zap
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  CONTROLLER_STORAGE_KEY,
  clearControllerRecovery,
  HOST_STORAGE_KEY,
  clearSession,
  connectRoom,
  consumeJoinFragment,
  hostedApi,
  isSessionRevokedError,
  partyJoinUrlFor,
  sessionJoinUrlFor,
  normalizeTrack,
  readSession,
  readControllerRecovery,
  writeControllerRecovery,
  writeSession
} from "../lib/hosted-api";
import { loadYouTubeIframeApi } from "../lib/youtube";
import { formatIdleCountdown } from "../lib/idle-session";
import stageImage from "../../design-preview/assets/kavaoke-family-home.png";
import {
  applyPreviewRoomView,
  emptyPreviewRoom,
  isDirectYouTubeInput,
  thumbnailFor
} from "./model";
import "../../design-preview/styles.css";
import "../../design-preview/polish.css";
import "../../design-preview/mobile-parity.css";
import "../../design-preview/host-display.css";
import "./runtime.css";

const FAVORITES_KEY = "karaoke.preview.live.favorites";
const HOST_PRESENTATION_KEY = "karaoke.hostPresentation";
const SEARCH_RESULT_LIMIT = 30;

function hostPresentationKey(roomId) {
  return roomId ? `${HOST_PRESENTATION_KEY}:${roomId}` : "";
}

function hasHostPresentation(roomId) {
  const key = hostPresentationKey(roomId);
  if (!key) return false;
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function clearHostPresentation(roomId) {
  const key = hostPresentationKey(roomId);
  if (!key) return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Private-mode storage can be unavailable; the in-memory state still resets.
  }
}

async function closeHostRoomWithRetry(roomId, token) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await hostedApi.closeRoom(roomId, token);
      return true;
    } catch {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return false;
}

function readFavorites() {
  try {
    const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return Array.isArray(value) ? value.filter((track) => track?.videoId && track?.title).slice(0, 100) : [];
  } catch {
    return [];
  }
}

function saveFavorites(items) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(items.slice(0, 100)));
  } catch {
    // Private browsing can disable local storage; favorites are still usable in memory.
  }
}

function Cover({ track, className = "" }) {
  const image = thumbnailFor(track);
  return (
    <div
      className={`cover real-cover ${className}`}
      style={image ? { backgroundImage: `url(${JSON.stringify(image)})` } : undefined}
      aria-hidden="true"
    />
  );
}

function RoomIcon({ size = 14, className = "" }) {
  return <DoorOpen className={`room-icon ${className}`.trim()} size={size} aria-hidden="true" />;
}

function Toast({ message, onClose, className = "" }) {
  if (!message) return null;
  return (
    <div className={`toast show ${className}`.trim()} role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" className="icon-button" aria-label="ปิดข้อความ" onClick={onClose}><X size={16} /></button>
    </div>
  );
}

function MarqueeTitle({ title, className = "" }) {
  const value = String(title || "");
  const isLong = value.length > 20;
  return (
    <strong className={`title-marquee ${isLong ? "is-long" : ""} ${className}`.trim()} title={value}>
      <span className="title-marquee-track">
        <span>{value}</span>
        {isLong && <span aria-hidden="true"> · {value}</span>}
      </span>
    </strong>
  );
}

export { formatIdleCountdown };

function searchTitleKey(title) {
  return String(title || "")
    .normalize("NFKC")
    .toLocaleLowerCase("th")
    .replace(/\b(?:official|karaoke|instrumental|backing[\s-]*track|version|cover)\b/giu, "")
    .replace(/คาราโอเกะ|อินสทรูเมนทัล|เวอร์ชัน|คัฟเวอร์/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function uniqueSearchResults(items) {
  const seenVideoIds = new Set();
  const seenTitles = new Set();
  return items.filter((item) => {
    const videoId = String(item?.videoId || "");
    const titleKey = searchTitleKey(item?.title);
    if (!videoId || seenVideoIds.has(videoId) || (titleKey && seenTitles.has(titleKey))) return false;
    seenVideoIds.add(videoId);
    if (titleKey) seenTitles.add(titleKey);
    return true;
  });
}

export function normalizeCatalogSuggestions(data) {
  return (data?.suggestions || [])
    .map(normalizeTrack)
    .filter((track) => track?.videoId && track?.title);
}

function catalogSearchText(track) {
  return [track?.artist, track?.title, track?.channelTitle, ...(track?.aliases || [])]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("th");
}

export function filterCatalogSuggestions(items, value) {
  const tokens = String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("th")
    .split(/\s+/u)
    .filter(Boolean);
  if (!tokens.length) return [];
  return items.filter((track) => {
    const candidate = catalogSearchText(track);
    return tokens.every((token) => candidate.includes(token));
  }).slice(0, SEARCH_RESULT_LIMIT);
}

export function PreviewYouTubeStage({ track, onEnded, onError, playback = emptyPreviewRoom.playback, restartNonce = 0 }) {
  const mountRef = useRef(null);
  const playerRef = useRef(null);
  const playerReadyRef = useRef(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const playbackRef = useRef(playback);
  const restartNonceRef = useRef(restartNonce);
  onEndedRef.current = onEnded;
  onErrorRef.current = onError;
  playbackRef.current = playback;
  const trackKey = track ? `${track.queueId || ""}:${track.videoId}` : "";

  useEffect(() => {
    let cancelled = false;
    let ended = false;
    let autoplayRetryTimer;
    playerReadyRef.current = false;
    restartNonceRef.current = restartNonce;
    setAutoplayBlocked(false);
    if (!track?.videoId || !mountRef.current) return undefined;

    const create = () => {
      if (cancelled || !mountRef.current) return;
      const mount = document.createElement("div");
      mountRef.current.appendChild(mount);
      playerRef.current = new window.YT.Player(mount, {
        videoId: track.videoId,
        playerVars: {
          autoplay: playbackRef.current.playing ? 1 : 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          playsinline: 1,
          rel: 0,
          // Keep YouTube's optional caption layer out of the karaoke video;
          // most karaoke uploads already burn the lyrics into the picture.
          cc_load_policy: 0,
          iv_load_policy: 3,
          origin: window.location.origin
        },
        events: {
          onReady: ({ target }) => {
            playerReadyRef.current = true;
            target.unloadModule?.("captions");
            const next = playbackRef.current;
            target.setVolume(next.volume);
            if (next.playing) {
              // Start muted first. Chromium and Safari block an unmuted
              // autoplay request when the Host has not received a gesture;
              // starting muted lets the new queue item begin immediately.
              // Audio is restored as soon as YouTube reports PLAYING below.
              target.mute?.();
              target.playVideo();
              // The IFrame can report ready a tick before the browser has
              // attached the media element. Retry once so a newly selected
              // song starts on the Host without requiring a second click.
              autoplayRetryTimer = window.setTimeout(() => {
                if (!cancelled && playbackRef.current.playing) target.playVideo();
              }, 180);
            }
            else {
              if (next.muted) target.mute?.();
              else target.unMute?.();
              target.pauseVideo();
            }
          },
          onStateChange: ({ data, target }) => {
            if (cancelled || ended) return;
            if (data === window.YT.PlayerState.PLAYING) {
              window.clearTimeout(autoplayRetryTimer);
              setAutoplayBlocked(false);
              const next = playbackRef.current;
              if (next.muted) target.mute?.();
              else {
                // Unmute only after playback has started. This avoids the
                // browser rejecting the initial play() while still restoring
                // the room volume automatically for normal karaoke use.
                target.unMute?.();
                target.setVolume?.(next.volume);
              }
            }
            if (data === window.YT.PlayerState.ENDED) {
              ended = true;
              onEndedRef.current?.();
            }
          },
          onError: ({ data }) => onErrorRef.current?.(data),
          onAutoplayBlocked: () => setAutoplayBlocked(true)
        }
      });
    };

    if (window.YT?.Player) create();
    else loadYouTubeIframeApi().then(create).catch(() => onErrorRef.current?.("loader"));

    return () => {
      cancelled = true;
      window.clearTimeout(autoplayRetryTimer);
      try {
        playerRef.current?.destroy?.();
      } catch {
        // The iframe may already have been removed by the browser.
      }
      playerRef.current = null;
      playerReadyRef.current = false;
      if (mountRef.current) mountRef.current.textContent = "";
    };
  }, [trackKey]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !playerReadyRef.current || restartNonce === restartNonceRef.current) return;
    restartNonceRef.current = restartNonce;
    try {
      player.seekTo?.(0, true);
      player.playVideo?.();
    } catch {
      // The IFrame API can still be settling after a room event; the next
      // playback update/onReady will retry with the latest state.
    }
  }, [restartNonce]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !playerReadyRef.current) return;
    try {
      player.setVolume?.(playback.volume);
      if (playback.muted) player.mute?.();
      else player.unMute?.();
      if (playback.playing) player.playVideo?.();
      else player.pauseVideo?.();
    } catch {
      // The IFrame API can still be initializing; onReady applies the latest room state.
    }
  }, [playback.playing, playback.volume, playback.muted]);

  const unlock = () => {
    playerRef.current?.unMute?.();
    playerRef.current?.setVolume?.(playbackRef.current.volume);
    playerRef.current?.playVideo?.();
    setAutoplayBlocked(false);
  };

  if (!track) return <img className="stage-media" src={stageImage} alt="เวทีคาราโอเกะ" />;
  return (
    <div className="preview-video-layer" aria-label={`กำลังเล่น ${track.title}`}>
      <div ref={mountRef} className="preview-video-mount" />
      {autoplayBlocked && (
        <button type="button" className="preview-audio-unlock" onClick={unlock}>
          เปิดเสียงเพื่อเริ่มเพลง
        </button>
      )}
    </div>
  );
}

function PreviewDisplayView() {
  const [session, setSession] = useState(() => readSession(HOST_STORAGE_KEY));
  const [room, setRoom] = useState(emptyPreviewRoom);
  const [presenting, setPresenting] = useState(() => {
    const initial = readSession(HOST_STORAGE_KEY);
    return Boolean(initial?.roomId && hasHostPresentation(initial.roomId));
  });
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [idleWarning, setIdleWarning] = useState(null);
  const [idleNow, setIdleNow] = useState(() => Date.now());
  const stageRef = useRef(null);
  const failureRef = useRef({ videoId: "", count: 0 });
  // Keep the active Host token in memory as the source of truth for socket
  // callbacks. sessionStorage is helpful for refreshes, but can be unavailable
  // in private browsing and must not let a revoked room clear a fresh session.
  const activeHostTokenRef = useRef(session?.token || "");

  const enterPresentation = useCallback((controllerCount) => {
    if (!session?.roomId || Number(controllerCount) <= 0) return;
    try {
      sessionStorage.setItem(hostPresentationKey(session.roomId), "1");
    } catch {
      // The transition remains valid for the current render even if storage is unavailable.
    }
    setPresenting(true);
  }, [session?.roomId]);

  useEffect(() => {
    setPresenting(Boolean(session?.roomId && hasHostPresentation(session.roomId)));
  }, [session?.roomId]);

  useEffect(() => {
    if (room.controllerCount > 0) enterPresentation(room.controllerCount);
  }, [enterPresentation, room.controllerCount]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!idleWarning?.closesAt) return undefined;
    const tick = () => setIdleNow(Date.now());
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [idleWarning?.closesAt]);

  const createRoom = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const previous = session;
      // Create the replacement first. If the network rejects the new room,
      // the current room and its queue remain usable instead of being lost.
      const created = await hostedApi.createRoom();
      const next = {
        roomId: created.roomId,
        token: created.hostToken,
        joinToken: created.joinToken,
        joinPath: created.joinPath,
        expiresAt: created.expiresAt,
        searchConfigured: created.searchConfigured
      };
      if (previous?.roomId && previous?.token) {
        await closeHostRoomWithRetry(previous.roomId, previous.token);
        clearHostPresentation(previous.roomId);
      }
      activeHostTokenRef.current = next.token;
      writeSession(HOST_STORAGE_KEY, next);
      setSession(next);
      setRoom(emptyPreviewRoom);
      setPresenting(false);
      setConnected(false);
      setIdleWarning(null);
      // The first room is created automatically on a fresh Host screen. Keep
      // that invite state quiet; only a deliberate room rotation needs feedback.
      setNotice(previous?.roomId ? "เปิดห้องใหม่แล้ว" : "");
    } catch (requestError) {
      setError(requestError.message || "สร้างห้องไม่สำเร็จ");
    } finally {
      setCreating(false);
    }
  }, [session]);

  useEffect(() => {
    if (!session && !creating) void createRoom();
  }, [session, creating, createRoom]);

  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    hostedApi.room(session.roomId, session.token)
      .then((view) => {
        if (live && activeHostTokenRef.current === session.token) {
          const nextRoom = applyPreviewRoomView(view, emptyPreviewRoom);
          setRoom(nextRoom);
          setIdleWarning(nextRoom.idle?.warning ? nextRoom.idle : null);
        }
      })
      .catch((requestError) => {
        if (!live || activeHostTokenRef.current !== session.token) return;
        if (isSessionRevokedError(`${requestError.code} ${requestError.status}`)) {
          clearHostPresentation(session.roomId);
          clearSession(HOST_STORAGE_KEY);
          activeHostTokenRef.current = "";
          setSession(null);
        } else {
          setError(requestError.message || "โหลดห้องไม่สำเร็จ");
        }
      });
    return () => { live = false; };
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    return connectRoom(session, (event) => {
      // Ignore late packets from a room socket that was revoked during a reset;
      // a freshly created Host session may already be mounted by then.
      if (activeHostTokenRef.current && activeHostTokenRef.current !== session.token) return;
      const activeSession = readSession(HOST_STORAGE_KEY);
      if (activeSession?.token && activeSession.token !== session.token) return;
      if (event.type === "connection") setConnected(event.connected);
      if (event.type === "room") {
        setRoom((previous) => {
          const nextRoom = applyPreviewRoomView(event.view, previous);
          setIdleWarning(nextRoom.idle?.warning ? nextRoom.idle : null);
          return nextRoom;
        });
      }
      if (event.type === "presence") {
        // New servers provide controller-only live sockets. For older servers,
        // `count` includes the Host socket, so subtract that one as a fallback.
        const rawConnectedControllerCount = Number(event.connectedControllerCount);
        const rawSocketCount = Number(event.count);
        const controllerCount = Number.isFinite(rawConnectedControllerCount)
          ? rawConnectedControllerCount
          : Math.max(0, (Number.isFinite(rawSocketCount) ? rawSocketCount : 0) - 1);
        setRoom((previous) => ({ ...previous, controllerCount, connectedControllerCount: controllerCount }));
        if (controllerCount > 0) enterPresentation(controllerCount);
        else setIdleWarning(null);
      }
      if (event.type === "idle-warning") setIdleWarning({ closesAt: event.closesAt, warningAt: event.warningAt });
      if (event.type === "action" && event.action?.action === "add") {
        setNotice(`เพิ่ม “${event.action.track?.title || "เพลง"}” แล้ว`);
      }
      if (event.type === "revoked") {
        clearHostPresentation(session.roomId);
        clearSession(HOST_STORAGE_KEY);
        activeHostTokenRef.current = "";
        setSession(null);
        setConnected(false);
        setIdleWarning(null);
      }
    });
  }, [enterPresentation, session]);

  const advance = useCallback(async () => {
    if (!session || !room.current) return;
    try {
      await hostedApi.advance(session.roomId, session.token, room.revision);
    } catch (requestError) {
      if (requestError.status !== 409) setNotice(requestError.message || "เลื่อนไปเพลงถัดไปไม่สำเร็จ");
    }
  }, [room.current, room.revision, session]);

  const reportFailure = useCallback(async (code) => {
    if (!session || !room.current) return;
    const unplayable = {
      2: "player_error",
      5: "player_error",
      100: "private",
      101: "embed_disabled",
      150: "embed_disabled"
    };
    const reason = unplayable[code];
    if (!reason) {
      // Loader/network failures are often transient (and common in restricted
      // browsers/CI). Keep the queue item so the user can retry or skip it.
      setNotice("โหลดวิดีโอไม่สำเร็จ กำลังลองใหม่");
      return;
    }

    const videoId = room.current.videoId;
    const tally = failureRef.current;
    if (tally.videoId !== videoId) failureRef.current = { videoId, count: 1 };
    else tally.count += 1;

    if (failureRef.current.count < 2) {
      setNotice("เล่นวิดีโอไม่สำเร็จ กำลังลองอีกครั้ง");
      return;
    }

    failureRef.current = { videoId, count: 0 };
    setNotice("เพลงนี้เล่นไม่ได้ กำลังข้ามไปเพลงถัดไป");
    try {
      await hostedApi.currentFailure(session.roomId, session.token, reason, `YouTube error ${code}`);
    } catch {
      // The socket snapshot remains the source of truth if the failure report races another action.
    }
  }, [room.current, session]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === stageRef.current) await document.exitFullscreen();
      else await stageRef.current?.requestFullscreen?.();
    } catch {
      setNotice("เบราว์เซอร์นี้ไม่อนุญาตให้เปิดเต็มจอ");
    }
  }, []);

  if (error) {
    return (
      <main className="host-display-page hosted-display-centered preview-functional-host">
        <div className="preview-host-error">
          <Mic2 size={42} />
          <h1>เปิดห้องไม่สำเร็จ</h1>
          <p>{error}</p>
          <button type="button" className="preview-host-button primary" onClick={createRoom}>ลองอีกครั้ง</button>
        </div>
      </main>
    );
  }

  if (!session) {
    return <main className="host-display-page hosted-display-centered preview-functional-host"><LoaderCircle className="spin" size={38} /></main>;
  }

  const next = room.queue[0];
  // Older host sessions may have been written before `joinPath` was added.
  // Rebuild the invite from the room-scoped token so the QR always encodes a
  // real, scannable controller URL after a refresh as well.
  const joinUrl = sessionJoinUrlFor(session);
  // Read the persisted presentation latch during render as well as in the
  // effect above. A refresh can paint the first frame before the effect runs;
  // consulting storage here prevents the QR lobby flashing back in that gap.
  const isPresenting = presenting || room.controllerCount > 0 || hasHostPresentation(session.roomId);
  const idleCountdown = idleWarning?.closesAt ? formatIdleCountdown(idleWarning.closesAt, idleNow) : "--:--";
  return (
    <main className={`host-display-page preview-functional-host ${isPresenting ? "is-presenting" : "is-invite"}`}>
      <section
        ref={stageRef}
        className={`display-stage ${isPresenting ? "is-presenting" : "is-invite"} ${room.current ? "has-current" : "is-ready"}`}
        data-display-mode={isPresenting ? "presentation" : "invite"}
        aria-label={room.current ? `จอเพลงจริง · ${room.current.title}` : "จอเพลงจริง · รอเพลงแรก"}
      >
        <PreviewYouTubeStage track={room.current} onEnded={advance} onError={reportFailure} playback={room.playback} restartNonce={room.restartNonce} />

        {idleWarning?.closesAt && (
          <aside className="host-idle-warning" role="alert" data-idle-warning>
            <span className="host-idle-warning-label">ห้องกำลังจะปิด</span>
            <span>{idleCountdown === "00:00" ? "กำลังปิดห้อง…" : `ไม่มีการเลือกเพลง · เหลือ ${idleCountdown}`}</span>
          </aside>
        )}

        {!isPresenting && (
          <aside className="join-corner invite-gate" aria-label="สแกน QR เพื่อเข้าห้อง">
            <p className="invite-brand" aria-label="KAVAOKE"><strong>KAVAOKE</strong></p>
            <div className="invite-gate-qr">
              <div className="real-qr"><QRCodeSVG value={joinUrl} size={224} bgColor="#f5f1e8" fgColor="#050607" /></div>
              <button type="button" className="scan-qr-button" onClick={() => setNotice("ใช้กล้องมือถือสแกน QR นี้เพื่อเข้าห้อง") } disabled={!joinUrl}>
                <QrCode size={15} /> SCAN QR TO JOIN
              </button>
            </div>
            <div className="invite-gate-copy">
              <div className="invite-room" aria-label={`รหัสห้อง ${session.roomId}`}><RoomIcon size={16} /><strong>{session.roomId}</strong></div>
              <div className="host-actions">
                <button type="button" onClick={createRoom} disabled={creating}>สร้างห้องใหม่</button>
              </div>
            </div>
          </aside>
        )}

        {isPresenting && (
          <aside className="system-track-bar" aria-label="รายละเอียดเพลงจาก Karaoke Station">
            <div className="system-track-copy">
              <span className="system-track-kicker">
                <i />
                <span className="system-track-kicker-label">{room.current ? "NOW PLAYING" : "KAVAOKE STATION"}</span>
                <span className="system-track-roomline"><RoomIcon size={14} /><span>{session.roomId}</span></span>
              </span>
              <strong title={room.current?.title || "ยังไม่มีเพลงที่เลือกไว้"}>{room.current?.title || "ยังไม่มีเพลงที่เลือกไว้"}</strong>
              <small className={`system-track-source ${room.current ? "has-source" : "is-empty"}`} aria-label={room.current ? `ช่อง YouTube ${room.current.channelTitle || "YouTube"}` : undefined}>
                {room.current && <strong title={room.current.channelTitle || "YouTube"}>{room.current.channelTitle || "YouTube"}</strong>}
              </small>
            </div>
            <div className="system-up-next">
              <div className="next-song up-next-chip" aria-label="เพลงถัดไป">
                <p>UP NEXT</p>
                <strong>{next?.title || (room.current ? "ยังไม่มีเพลงถัดไป" : "รอเพลงแรก")}</strong>
                <span>{next ? `เลือกโดย ${next.requestedBy || "สมาชิกในห้อง"}` : "เพิ่มเพลงจากมือถือ"}</span>
              </div>
            </div>
            <span
              className={`system-track-status ${connected ? "is-online" : "is-offline"}`}
              aria-label={connected ? "LIVE เชื่อมต่อปกติ" : "LIVE หลุดการเชื่อมต่อ"}
            >
              <i aria-hidden="true" />
              <span>LIVE</span>
            </span>
          </aside>
        )}

        <div className="display-controls" data-controls>
          {isPresenting && (
            <button
              type="button"
              className="room-reset-control"
              onClick={createRoom}
              disabled={creating}
              aria-label="รีเซ็ตห้องกลับไปหน้า QR"
              title="รีเซ็ตห้องกลับไปหน้า QR"
            >
              <Zap size={17} />
            </button>
          )}
          <button type="button" className="fullscreen-control" onClick={toggleFullscreen} aria-label="เข้าสู่โหมดเต็มหน้าจอ">
            <Maximize2 size={17} />
          </button>
        </div>
      </section>
      <Toast message={notice} className="host-toast" onClose={() => setNotice("")} />
    </main>
  );
}

function PreviewJoinView({ roomId, joinToken, onJoin }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inviteUrl = roomId && joinToken ? partyJoinUrlFor(roomId, joinToken) : "";

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || !roomId || !joinToken) return;
    setLoading(true);
    setError("");
    try {
      await onJoin(name.trim());
    } catch (requestError) {
      setError(requestError.message || "เข้าห้องไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  const shareInvite = async () => {
    if (!inviteUrl) return;
    try {
      if (navigator.share) await navigator.share({ title: "Karaoke Station", text: `เข้าห้อง ${roomId}`, url: inviteUrl });
      else await navigator.clipboard.writeText(inviteUrl);
    } catch {
      // Sharing is optional before joining; the QR remains the primary path.
    }
  };

  return (
    <main className="mobile-preview preview-functional-app">
      <section className="phone join-phone" aria-label="เข้าห้อง Karaoke Station" inert>
        <header className="phone-header">
          <div className="brand-block"><a className="wordmark" href="/"><strong>KAVAOKE</strong> <i>STATION</i></a><p className="room-meta"><span className="status-dot" /><RoomIcon size={12} /> {roomId || "—"} · LIVE</p></div>
          <div className="header-actions">
            <button type="button" className="share-button svg-button" onClick={shareInvite} disabled={!inviteUrl} aria-label="เปิดคำเชิญห้อง"><Share2 size={16} /><span>แชร์</span></button>
            <button type="button" className="settings-button svg-button" disabled aria-label="ตั้งค่าห้อง"><Settings size={18} /></button>
          </div>
        </header>
        <section className="phone-content" aria-live="polite">
          <form className="search-box" onSubmit={(event) => event.preventDefault()}>
            <input aria-label="ค้นหาชื่อเพลง ศิลปิน หรือลิงก์ YouTube" disabled placeholder="ชื่อเพลง, ศิลปิน หรือ YouTube URL" />
            <button type="submit" aria-label="ค้นหา" disabled><Search size={20} /></button>
          </form>
          <div className="chips" aria-label="ตัวกรองเพลง">
            <button type="button" className="active" disabled>ทั้งหมด</button>
            <button type="button" disabled>☆ เพลงโปรด (0)</button>
          </div>
          <div className="empty-state"><b>เข้าร่วมห้องก่อนค้นหาเพลง</b><span>ใส่ชื่อของคุณในหน้าต่างด้านล่างเพื่อเริ่มเลือกเพลง</span></div>
        </section>
        <section className="now-dock" aria-label="เพลงปัจจุบันและรีโมท">
          <Cover track={null} className="waiting-art" />
          <button type="button" className="dock-play disabled" disabled aria-label="เล่นเพลง"><Play size={20} /></button>
          <button type="button" className="dock-details" disabled><span>WAITING</span><strong>รอเพลงแรก</strong><small>เข้าร่วมห้องเพื่อเพิ่มเพลง</small></button>
          <button type="button" className="dock-expand svg-button" disabled aria-label="เปิดรีโมท"><Maximize2 size={18} /></button>
        </section>
        <nav className="bottom-nav" aria-label="เมนูหลัก">
          <button type="button" className="active" disabled><span><Search size={19} /></span>ค้นหา</button>
          <button type="button" disabled><span><ListMusic size={19} /></span>คิว <i>0</i></button>
          <button type="button" disabled><span><History size={19} /></span>ประวัติ</button>
        </nav>
      </section>
      <div className="sheet-root">
        <div className="sheet-backdrop" aria-hidden="true" />
        <section className="remote-sheet compact-sheet join-sheet" role="dialog" aria-modal="true" aria-labelledby="joinTitle">
          <h2 id="joinTitle" className="join-room-heading"><RoomIcon size={20} /><span>{roomId || "—"}</span></h2>
          {roomId && joinToken ? (
            <form id="joinForm" onSubmit={submit}>
              <label className="copy-field">ชื่อของคุณ<input autoFocus maxLength={20} value={name} onChange={(event) => setName(event.target.value)} placeholder="เช่น Nut" /></label>
              {error && <p className="form-error">{error}</p>}
              <button type="submit" className="sheet-action" disabled={loading || !name.trim()}>{loading ? "กำลังเข้าห้อง…" : "เข้าร่วมห้อง"}</button>
            </form>
          ) : (
            <div className="empty-state"><b>ต้องสแกน QR จากจอ Host</b><span>ลิงก์นี้ไม่มีข้อมูลเข้าห้องที่ปลอดภัย</span></div>
          )}
        </section>
      </div>
    </main>
  );
}

function SongRow({ track, favorite, onFavorite, onAdd }) {
  return (
    <li className="song-row">
      <Cover track={track} />
      <div className="song-info">
        {track.badge && <span className="type-badge">{track.badge}</span>}
        <MarqueeTitle title={track.title} />
        <small>{track.channelTitle || "YouTube"}</small>
      </div>
      <div className="song-actions">
        <button type="button" className={`favorite ${favorite ? "is-favorite" : ""}`} onClick={() => onFavorite(track)} aria-label={favorite ? "ลบจากเพลงโปรด" : "บันทึกเพลงโปรด"}>
          <Star size={19} fill={favorite ? "currentColor" : "none"} />
        </button>
        <button type="button" className="add-button" onClick={() => onAdd(track)} aria-label={`เพิ่ม ${track.title}`}><Plus size={20} /></button>
      </div>
    </li>
  );
}

function CatalogSuggestionRow({ track, favorite, onFavorite, onAdd, busy }) {
  const isBusy = busy === `add:${track.videoId}`;
  return (
    <li className="catalog-suggestion-row">
      <button
        type="button"
        className="catalog-suggestion-select"
        role="option"
        onClick={() => onAdd(track)}
        disabled={isBusy}
      >
        <span className="catalog-suggestion-copy">
          <strong>{track.title}</strong>
          <small>{track.artist || track.channelTitle || "ไม่ระบุศิลปิน"}</small>
        </span>
      </button>
      <div className="catalog-suggestion-actions" aria-label={`การกระทำสำหรับ ${track.title}`}>
        <button
          type="button"
          className={`catalog-suggestion-favorite${favorite ? " is-favorite" : ""}`}
          aria-label={favorite ? "ลบจากเพลงโปรด" : "บันทึกเพลงโปรด"}
          title={favorite ? "ลบจากเพลงโปรด" : "บันทึกเพลงโปรด"}
          onClick={() => onFavorite(track)}
        >
          <Star size={17} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="catalog-suggestion-add"
          aria-label={`เพิ่ม ${track.title} เข้าคิว`}
          title={`เพิ่ม ${track.title} เข้าคิว`}
          onClick={() => onAdd(track)}
          disabled={isBusy}
        >
          <Plus size={18} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

function SortableQueueItem({ track, index, busy, onPlayNow, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.queueId,
    disabled: Boolean(busy)
  });
  return (
    <article
      ref={setNodeRef}
      className={`queue-item ${isDragging ? "is-dragging" : ""}`.trim()}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="queue-order">
        <button
          type="button"
          className="queue-drag-handle"
          aria-label={`กดค้างแล้วลากเพื่อย้าย ${track.title}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>
        <span className="queue-pos">{String(index + 1).padStart(2, "0")}</span>
      </div>
      <Cover track={track} />
      <div>
        <MarqueeTitle title={track.title} className="queue-title-marquee" />
        <small>{track.channelTitle || "YouTube"} · ขอโดย {track.requestedBy || "สมาชิก"}</small>
        <div className="queue-controls">
          <button type="button" className="play-now" onClick={() => onPlayNow(track)} disabled={Boolean(busy)}>
            <Play size={13} /> เล่นทันที
          </button>
          <button type="button" className="remove" onClick={() => onRemove(track)} disabled={Boolean(busy)} aria-label="ลบเพลง">
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}

const MEMBER_SWIPE_DISTANCE = 164;
const MEMBER_SWIPE_TRIGGER = 52;

function OnlineMemberRow({ member, isSelf, canKick, revealed, onReveal, onCancel, onKick }) {
  const [dragOffset, setDragOffset] = useState(0);
  const gestureRef = useRef(null);

  const resetGesture = (event) => {
    const gesture = gestureRef.current;
    if (gesture && event?.pointerId === gesture.pointerId) {
      event.currentTarget.releasePointerCapture?.(gesture.pointerId);
    }
    gestureRef.current = null;
    setDragOffset(0);
  };

  const onPointerDown = (event) => {
    if (!canKick || isSelf || event.target.closest("button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cancelled: false
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.cancelled) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
      gesture.cancelled = true;
      setDragOffset(0);
      return;
    }
    const base = revealed ? -MEMBER_SWIPE_DISTANCE : 0;
    const next = Math.max(-MEMBER_SWIPE_DISTANCE, Math.min(0, base + deltaX));
    if (next !== base) {
      event.preventDefault();
      setDragOffset(next - base);
    }
  };

  const onPointerUp = (event) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const cancelled = gesture.cancelled;
    resetGesture(event);
    if (cancelled) return;
    if (revealed && deltaX >= MEMBER_SWIPE_TRIGGER) {
      onCancel();
    } else if (!revealed && deltaX <= -MEMBER_SWIPE_TRIGGER) {
      onReveal();
    }
  };

  const onKeyDown = (event) => {
    if (!canKick || isSelf || revealed) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onReveal();
    }
  };

  const transform = revealed
    ? `translateX(${-(MEMBER_SWIPE_DISTANCE - dragOffset)}px)`
    : `translateX(${dragOffset}px)`;

  return (
    <div className="member-swipe-shell">
      <div className={`member-swipe-actions${revealed ? " is-visible" : ""}`} aria-hidden={!revealed}>
        <button type="button" className="member-kick-yes" onClick={onKick} aria-label={`เตะ ${member.displayName} ออก`}>
          <Check size={16} />
          <span>เตะ</span>
        </button>
        <button type="button" className="member-kick-no" onClick={onCancel} aria-label="ยกเลิก">
          <X size={16} />
          <span>ยกเลิก</span>
        </button>
      </div>
      <div
        className={`member-row ${member.isLeader ? "is-leader" : ""} ${isSelf ? "is-self" : ""} ${revealed ? "is-confirming" : ""} ${dragOffset ? "is-dragging" : ""}`.trim()}
        style={{ transform }}
        role={canKick && !isSelf ? "button" : undefined}
        tabIndex={canKick && !isSelf ? 0 : undefined}
        aria-expanded={canKick && !isSelf ? revealed : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={resetGesture}
        onKeyDown={onKeyDown}
      >
        <div className="member-copy">
          <strong>{member.displayName}</strong>
          <span>{member.isLeader ? "หัวหน้าปาร์ตี้" : isSelf ? "คุณ" : "ออนไลน์"}</span>
        </div>
      </div>
    </div>
  );
}

function PreviewController({ session, onRevoked }) {
  const [tab, setTab] = useState("search");
  const [filter, setFilter] = useState("all");
  const [room, setRoom] = useState(emptyPreviewRoom);
  const [connected, setConnected] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [catalogSuggestions, setCatalogSuggestions] = useState([]);
  const [catalogSeed, setCatalogSeed] = useState([]);
  const [catalogPhase, setCatalogPhase] = useState("idle");
  const [phase, setPhase] = useState("idle");
  const [favorites, setFavorites] = useState(readFavorites);
  const [history, setHistory] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [kickTarget, setKickTarget] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [fairSaving, setFairSaving] = useState(false);
  const [volumeDraft, setVolumeDraft] = useState(null);
  const queueSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 260, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const playbackPending = useRef(null);
  const playbackMutating = useRef(false);
  const volumeTimer = useRef(null);
  const searchRunRef = useRef(0);
  const catalogRunRef = useRef(0);
  const previousActionRef = useRef({ timer: null, promise: null });

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => () => {
    clearTimeout(volumeTimer.current);
    clearTimeout(previousActionRef.current.timer);
  }, []);

  useEffect(() => connectRoom(session, (event) => {
    if (event.type === "connection") setConnected(event.connected);
    if (event.type === "room") setRoom((previous) => applyPreviewRoomView(event.view, previous));
    if (event.type === "presence") {
      setRoom((previous) => ({
        ...previous,
        controllerCount: Number.isFinite(Number(event.connectedControllerCount))
          ? Number(event.connectedControllerCount)
          : Number.isFinite(Number(event.controllerCount))
            ? Number(event.controllerCount)
            : previous.controllerCount,
        connectedControllerCount: Number.isFinite(Number(event.connectedControllerCount))
          ? Number(event.connectedControllerCount)
          : previous.connectedControllerCount,
        members: Array.isArray(event.members) ? event.members : previous.members
      }));
    }
    if (event.type === "revoked") onRevoked(event.code);
  }), [session, onRevoked]);

  useEffect(() => {
    let live = true;
    hostedApi.queue(session.roomId, session.token)
      .then((view) => { if (live) setRoom((previous) => applyPreviewRoomView(view, previous)); })
      .catch((requestError) => {
        if (live && isSessionRevokedError(`${requestError.code} ${requestError.status}`)) onRevoked(requestError.code || requestError.status);
      });
    return () => { live = false; };
  }, [session, onRevoked]);

  useEffect(() => {
    if (tab !== "history") return undefined;
    let live = true;
    hostedApi.history(session.roomId, session.token)
      .then((data) => { if (live) setHistory(data.history || []); })
      .catch((requestError) => {
        if (live && isSessionRevokedError(`${requestError.code} ${requestError.status}`)) onRevoked(requestError.code || requestError.status);
      });
    return () => { live = false; };
  }, [onRevoked, room.revision, session, tab]);

  const guard = useCallback(async (operation) => {
    try {
      return await operation();
    } catch (requestError) {
      if (isSessionRevokedError(`${requestError.code} ${requestError.status}`)) onRevoked(requestError.code || requestError.status);
      throw requestError;
    }
  }, [onRevoked]);

  // Warm the Sheet catalog as soon as the controller is mounted. The first
  // typed character can then filter local data while the room-scoped refresh
  // runs in the background, instead of making the user wait for a cold Sheet
  // OAuth/read request after opening the search field.
  useEffect(() => {
    let active = true;
    hostedApi.catalogSuggestions(session.roomId, session.token, "", { limit: SEARCH_RESULT_LIMIT })
      .then((data) => {
        if (!active) return;
        setCatalogSeed(normalizeCatalogSuggestions(data));
      })
      .catch((requestError) => {
        if (active && isSessionRevokedError(`${requestError.code} ${requestError.status}`)) onRevoked(requestError.code || requestError.status);
      });
    return () => { active = false; };
  }, [onRevoked, session.roomId, session.token]);

  useEffect(() => {
    const value = query.trim();
    const catalogRun = catalogRunRef.current + 1;
    catalogRunRef.current = catalogRun;

    if (tab !== "search" || filter !== "all" || !value || isDirectYouTubeInput(value)) {
      setCatalogSuggestions([]);
      setCatalogPhase("idle");
      return undefined;
    }

    const localSuggestions = filterCatalogSuggestions(catalogSeed, value);
    setCatalogSuggestions(localSuggestions);
    setCatalogPhase(localSuggestions.length ? "ready" : "loading");
    let active = true;
    const timer = window.setTimeout(() => {
      hostedApi.catalogSuggestions(session.roomId, session.token, value)
        .then((data) => {
          if (!active || catalogRun !== catalogRunRef.current) return;
          setCatalogSuggestions(normalizeCatalogSuggestions(data));
          setCatalogPhase("done");
        })
        .catch((requestError) => {
          if (!active || catalogRun !== catalogRunRef.current) return;
          if (isSessionRevokedError(`${requestError.code} ${requestError.status}`)) onRevoked(requestError.code || requestError.status);
          // Keep already-warmed local rows visible if the refresh request is
          // temporarily unavailable. A catalog outage should not block a
          // normal YouTube search or hide useful suggestions.
          if (!localSuggestions.length) {
            setCatalogSuggestions([]);
            setCatalogPhase("error");
          }
        });
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [catalogSeed, filter, onRevoked, query, session.roomId, session.token, tab]);

  const doSearch = async (event) => {
    event?.preventDefault();
    const value = query.trim();
    if (!value) return;
    const searchRun = searchRunRef.current + 1;
    searchRunRef.current = searchRun;
    setPhase("loading");
    setResults([]);
    // A catalog row is an optional shortcut, not a replacement for an
    // explicit search. Submitting the form must always query YouTube for the
    // typed text, even while cached Sheet suggestions are visible.
    catalogRunRef.current += 1;
    setCatalogSuggestions([]);
    setCatalogPhase("idle");
    try {
      const data = isDirectYouTubeInput(value)
        ? { results: [await guard(() => hostedApi.resolveYouTube(session.roomId, session.token, value))] }
        : await guard(() => hostedApi.search(session.roomId, session.token, value, "both", { limit: SEARCH_RESULT_LIMIT }));
      if (searchRun !== searchRunRef.current) return;
      setResults(uniqueSearchResults((data.results || []).map(normalizeTrack).filter(Boolean)).slice(0, SEARCH_RESULT_LIMIT));
      setPhase("done");
    } catch (requestError) {
      if (searchRun !== searchRunRef.current) return;
      setResults([]);
      setPhase("error");
      setNotice(requestError.message || "ค้นหาไม่สำเร็จ");
    }
  };

  const add = async (track) => {
    setBusy(`add:${track.videoId}`);
    try {
      await guard(() => hostedApi.addTrack(session.roomId, session.token, track));
      setNotice(`เพิ่ม “${track.title}” เข้าคิวแล้ว`);
      return true;
    } catch (requestError) {
      setNotice(requestError.message || "เพิ่มเพลงไม่สำเร็จ");
      return false;
    } finally {
      setBusy("");
    }
  };

  const addCatalogSuggestion = async (track) => {
    if (await add(track)) {
      setQuery("");
      setResults([]);
      setCatalogSuggestions([]);
      setCatalogPhase("idle");
      setPhase("idle");
    }
  };

  const toggleFavorite = (track) => {
    const exists = favorites.some((item) => item.videoId === track.videoId);
    const next = exists ? favorites.filter((item) => item.videoId !== track.videoId) : [track, ...favorites];
    setFavorites(next);
    saveFavorites(next);
    setNotice(exists ? "ลบเพลงโปรดแล้ว" : "บันทึกเพลงโปรดไว้ในเครื่องนี้แล้ว");
  };

  const remove = async (track) => {
    setBusy(`remove:${track.queueId}`);
    try {
      await guard(() => hostedApi.removeTrack(session.roomId, session.token, track.queueId, room.revision));
      setNotice(`ลบ “${track.title}” แล้ว`);
    } catch (requestError) {
      setNotice(requestError.message || "คิวเปลี่ยนไปแล้ว กรุณาลองใหม่");
    } finally {
      setBusy("");
    }
  };

  const playNow = async (track) => {
    setBusy(`play:${track.queueId}`);
    try {
      await guard(() => hostedApi.playNow(session.roomId, session.token, track.queueId, room.revision));
      setNotice(`เริ่ม “${track.title}” ทันทีแล้ว`);
      setSheet(null);
    } catch (requestError) {
      setNotice(requestError.message || "เล่นทันทีไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const reorder = async (track, toIndex) => {
    if (toIndex < 0 || toIndex >= room.queue.length || busy) return;
    setBusy(`move:${track.queueId}`);
    try {
      await guard(() => hostedApi.reorder(session.roomId, session.token, track.queueId, toIndex, room.revision));
      setNotice("เปลี่ยนลำดับคิวแล้ว");
    } catch (requestError) {
      setNotice(requestError.message || "ย้ายคิวไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const queueDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id || busy) return;
    const fromIndex = room.queue.findIndex((item) => item.queueId === active.id);
    const toIndex = room.queue.findIndex((item) => item.queueId === over.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    void reorder(room.queue[fromIndex], toIndex);
  };

  const skip = async () => {
    if (!room.current || busy) return;
    setBusy("skip");
    try {
      await guard(() => hostedApi.skip(session.roomId, session.token, room.revision));
      setNotice("ข้ามเพลงแล้ว");
      setSheet(null);
    } catch (requestError) {
      setNotice(requestError.message || "ข้ามเพลงไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const restartCurrent = async () => {
    if (!room.current) return null;
    try {
      const result = await guard(() => hostedApi.restart(session.roomId, session.token, room.revision));
      setRoom((previous) => ({
        ...previous,
        revision: Math.max(previous.revision, Number(result?.revision) || previous.revision),
        restartNonce: Number(result?.restartNonce) || previous.restartNonce,
        playback: { ...previous.playback, ...(result?.playback || {}), playing: true }
      }));
      setNotice("เริ่มเพลงเดิมใหม่แล้ว");
      return result;
    } catch (requestError) {
      setNotice(requestError.message || "เริ่มเพลงใหม่ไม่สำเร็จ");
      return null;
    }
  };

  const previousTrack = async (revision) => {
    if (!room.current || busy) return null;
    setBusy("previous");
    try {
      const result = await guard(() => hostedApi.previous(session.roomId, session.token, revision));
      setRoom((previous) => applyPreviewRoomView({
        revision: result?.revision,
        current: result?.current,
        queue: result?.queue
      }, previous));
      setNotice("ย้อนกลับไปเพลงก่อนหน้าแล้ว");
      setSheet(null);
      return result;
    } catch (requestError) {
      setNotice(requestError.message || "ยังไม่มีเพลงก่อนหน้า");
      return null;
    } finally {
      setBusy("");
    }
  };

  // The first press is intentionally immediate: it restarts the current item.
  // A second press inside the short double-press window reuses the revision
  // returned by the restart and asks the server for the previous history item.
  const handlePrevious = () => {
    const pending = previousActionRef.current;
    if (pending.promise) {
      clearTimeout(pending.timer);
      previousActionRef.current = { timer: null, promise: null };
      void pending.promise.then((result) => {
        if (result?.revision !== undefined) void previousTrack(result.revision);
      });
      return;
    }
    const promise = restartCurrent();
    const timer = window.setTimeout(() => {
      previousActionRef.current = { timer: null, promise: null };
    }, 450);
    previousActionRef.current = { timer, promise };
  };

  const toggleFairQueue = async () => {
    if (fairSaving) return;
    setFairSaving(true);
    const enabled = !Boolean(room.settings?.fairQueue);
    try {
      const result = await guard(() => hostedApi.updateSettings(session.roomId, session.token, { fairQueue: enabled }));
      setRoom((previous) => ({
        ...previous,
        revision: Math.max(previous.revision, Number(result?.revision) || previous.revision),
        settings: { ...previous.settings, ...(result?.settings || {}), fairQueue: enabled }
      }));
      setNotice(enabled ? "เปิดโหมดผลัดกันร้องแล้ว" : "ปิดโหมดผลัดกันร้องแล้ว");
    } catch (requestError) {
      setNotice(requestError.message || "เปลี่ยนโหมดคิวไม่สำเร็จ");
    } finally {
      setFairSaving(false);
    }
  };

  const flushPlayback = async () => {
    if (playbackMutating.current || !playbackPending.current) return;
    const patch = playbackPending.current;
    playbackPending.current = null;
    playbackMutating.current = true;
    try {
      await guard(() => hostedApi.updatePlayback(session.roomId, session.token, patch));
    } catch (requestError) {
      setNotice(requestError.message || "เปลี่ยนการเล่นไม่สำเร็จ");
    } finally {
      playbackMutating.current = false;
      if (playbackPending.current) void flushPlayback();
    }
  };

  const updatePlayback = (patch) => {
    if (!current) return;
    setRoom((previous) => ({
      ...previous,
      playback: { ...previous.playback, ...patch }
    }));
    playbackPending.current = { ...(playbackPending.current || {}), ...patch };
    void flushPlayback();
  };

  const changeVolume = (event) => {
    const volume = Number(event.target.value);
    setVolumeDraft(volume);
    clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(() => {
      updatePlayback({ volume });
      setVolumeDraft(null);
    }, 240);
  };

  const onlineMembers = Array.isArray(room.members) ? room.members : [];
  const isPartyLeader = onlineMembers.some((member) => member.controllerId === session.controllerId && member.isLeader);

  const leaveRoom = async () => {
    try {
      await hostedApi.leave(session.roomId, session.token);
    } catch {
      // Local leave still has to drop the session even if the network already expired it.
    }
    clearSession(CONTROLLER_STORAGE_KEY);
    onRevoked("member_left");
  };

  const confirmKick = async () => {
    if (!kickTarget?.controllerId) return;
    try {
      await hostedApi.kickMember(session.roomId, session.token, kickTarget.controllerId);
      setNotice(`เตะ ${kickTarget.displayName} ออกจากปาร์ตี้แล้ว`);
    } catch (requestError) {
      setNotice(requestError.message || "เตะสมาชิกไม่สำเร็จ");
    } finally {
      setKickTarget(null);
    }
  };

  const shareRoom = async () => {
    const url = partyJoinUrlFor(session.roomId, session.joinToken);
    try {
      if (navigator.share) await navigator.share({ title: "Karaoke Station", text: `เข้าห้อง ${session.roomId}`, url });
      else await navigator.clipboard.writeText(url);
      setNotice("ลิงก์เข้าห้องพร้อมส่งให้เพื่อนแล้ว");
    } catch {
      setNotice("ยังไม่ได้แชร์ลิงก์");
    }
  };

  const favoriteResults = useMemo(() => favorites.map(normalizeTrack).filter(Boolean), [favorites]);
  const displayedResults = filter === "favorites" ? favoriteResults : results;
  const current = room.current;

  return (
    <main className="mobile-preview preview-functional-app">
      <section className="phone" aria-label="Karaoke Station mobile remote" inert={Boolean(sheet)}>
        <header className="phone-header">
          <div className="brand-block">
            <a className="wordmark" href="/"><strong>KAVAOKE</strong> <i>STATION</i></a>
            <p className="room-meta"><span className={`status-dot ${connected ? "is-online" : ""}`} /><RoomIcon size={12} /> <span>{session.roomId}</span><span>·</span><span>{connected ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ"}</span></p>
          </div>
          <div className="header-actions">
            <button type="button" className="share-button svg-button" onClick={() => setSheet("share")} aria-label="เปิดคำเชิญห้อง"><Share2 size={16} /><span>แชร์</span></button>
            <button type="button" className="settings-button svg-button" onClick={() => setSheet("settings")} aria-label="ดูข้อมูลห้อง"><Settings size={18} /></button>
          </div>
        </header>

        <section className="phone-content" aria-live="polite">
          {tab === "search" && (
            <>
              <div className="catalog-autocomplete">
                <form className="search-box" onSubmit={doSearch}>
                  <input
                    aria-label="ค้นหาชื่อเพลง ศิลปิน หรือลิงก์ YouTube"
                    aria-autocomplete="list"
                    aria-controls={catalogSuggestions.length ? "catalog-suggestions" : undefined}
                    aria-expanded={catalogSuggestions.length > 0}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                    placeholder="ชื่อเพลง, ศิลปิน หรือ YouTube URL"
                    autoComplete="off"
                  />
                  <button type="submit" aria-label="ค้นหา"><Search size={20} /></button>
                </form>
                {catalogPhase === "loading" && <p className="catalog-loading" role="status"><LoaderCircle className="spin" size={15} /> กำลังค้นหาในคลังเพลง…</p>}
                {catalogPhase === "error" && <p className="catalog-feedback" role="status">โหลดรายการแนะนำไม่สำเร็จ — กดค้นหาเพื่อค้นหา YouTube ได้</p>}
                {catalogSuggestions.length > 0 && (
                  <ul className="catalog-suggestions" id="catalog-suggestions" role="listbox" aria-label="เพลงแนะนำจากคลัง">
                    {catalogSuggestions.map((track) => (
                      <CatalogSuggestionRow
                        key={track.videoId}
                        track={track}
                        favorite={favorites.some((item) => item.videoId === track.videoId)}
                        onFavorite={toggleFavorite}
                        onAdd={addCatalogSuggestion}
                        busy={busy}
                      />
                    ))}
                  </ul>
                )}
              </div>
              <div className="chips" aria-label="ตัวกรองเพลง">
                <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>ทั้งหมด</button>
                <button type="button" className={filter === "favorites" ? "active" : ""} onClick={() => setFilter("favorites")}>☆ เพลงโปรด ({favorites.length})</button>
              </div>
              <p className="mobile-tip"><strong>Tips</strong> คุณสามารถกดดาวเพื่อเพิ่มเพลงโปรดไว้ในเครื่องได้</p>
              {phase === "loading" && <div className="empty-state"><LoaderCircle className="spin" size={30} /><span>กำลังค้นหาจาก YouTube…</span></div>}
              {phase === "error" && <div className="empty-state"><b>ค้นหาไม่สำเร็จ</b><span>ตรวจลิงก์หรือคำค้น แล้วลองใหม่อีกครั้ง</span></div>}
              {filter === "favorites" && displayedResults.length === 0 && <div className="empty-state"><b>ยังไม่มีเพลงโปรด</b><span>กดดาวที่เพลงเพื่อเก็บไว้ในเครื่องนี้</span></div>}
              {phase === "done" && filter === "all" && displayedResults.length === 0 && <div className="empty-state"><b>ไม่พบเพลง</b><span>ลองเพิ่มชื่อศิลปิน หรือวางลิงก์ YouTube โดยตรง</span></div>}
              {displayedResults.length > 0 && <div className="result-heading"><p>{filter === "favorites" ? "เพลงโปรดของฉัน" : "ผลการค้นหา"}</p><small>{displayedResults.length} รายการ</small></div>}
              <ul className="song-list">
                {displayedResults.map((track) => <SongRow key={track.videoId} track={track} favorite={favorites.some((item) => item.videoId === track.videoId)} onFavorite={toggleFavorite} onAdd={add} />)}
              </ul>
            </>
          )}

          {tab === "queue" && (
            <>
              <section className="queue-title"><h1>คิวของเรา</h1><p>{room.queue.length} เพลง</p></section>
              <section className="fair-toggle"><div><strong>ผลัดกันร้อง</strong><small>{room.settings?.fairQueue ? "เปิดอยู่ · ระบบกระจายคิวตามผู้ขอ" : "ปิดอยู่ · จัดลำดับเองได้"}</small></div><button type="button" className={`switch ${room.settings?.fairQueue ? "on" : ""}`} onClick={toggleFairQueue} disabled={fairSaving} aria-pressed={Boolean(room.settings?.fairQueue)}><i /></button></section>
              <section className="queue-list">
                {room.queue.length === 0 && <div className="empty-state"><b>คิวว่างอยู่</b><span>กลับไปค้นหาเพลงที่อยากร้องได้เลย</span></div>}
                {room.queue.length > 0 && <DndContext sensors={queueSensors} collisionDetection={closestCenter} onDragEnd={queueDragEnd}>
                  <SortableContext items={room.queue.map((item) => item.queueId)} strategy={verticalListSortingStrategy}>
                    {room.queue.map((track, index) => <SortableQueueItem key={track.queueId} track={track} index={index} busy={busy} onPlayNow={playNow} onRemove={remove} />)}
                  </SortableContext>
                </DndContext>}
              </section>
            </>
          )}

          {tab === "history" && (
            <>
              <section className="history-title"><div className="history-heading"><h1>ประวัติการร้อง</h1><p className="history-count">{history.length} เพลง</p></div></section>
              <section className="history-list">
                {history.length === 0 && <div className="empty-state"><b>ยังไม่มีประวัติการร้อง</b><span>เพลงที่ร้องจบจะแสดงที่นี่</span></div>}
                {history.map((item, index) => {
                  const track = normalizeTrack(item);
                  return <article className="history-row" key={item.id || `${item.videoId}-${index}`}><Cover track={track} /><div><MarqueeTitle title={track.title} /><small>{track.channelTitle || "YouTube"} · {item.status === "completed" ? "ร้องจบแล้ว" : item.status === "skipped" ? "ข้ามแล้ว" : "หยุดก่อนจบ"}</small></div><button type="button" className="readd" onClick={() => add(track)} disabled={busy === `add:${track.videoId}`}><Plus size={14} /> ร้องอีก</button></article>;
                })}
              </section>
            </>
          )}
        </section>

        <section className="now-dock" aria-label="เพลงปัจจุบันและรีโมท">
          <Cover track={current} className={!current ? "waiting-art" : ""} />
          <button
            type="button"
            className="dock-play svg-button"
            onClick={() => updatePlayback({ playing: !room.playback?.playing })}
            disabled={!current || Boolean(busy)}
            aria-label={room.playback?.playing ? "พักเพลง" : "เล่นเพลงต่อ"}
          >
            {room.playback?.playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button type="button" className="dock-details" onClick={() => setSheet("remote")}><span>{current ? "Now playing" : "WAITING"}</span><MarqueeTitle title={current?.title || "รอเพลงแรก"} /><small>{current ? `${current.channelTitle || "YouTube"} · ${current.requestedBy || "สมาชิก"}` : "เพิ่มเพลงจากหน้าค้นหาได้เลย"}</small></button>
          <button type="button" className="dock-expand svg-button" onClick={() => setSheet("remote")} aria-label="เปิดรีโมท"><Maximize2 size={18} /></button>
        </section>

        <nav className="bottom-nav" aria-label="เมนูหลัก">
          <button type="button" className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}><span><Search size={19} /></span>ค้นหา</button>
          <button type="button" className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}><span><ListMusic size={19} /></span>คิว <i>{room.queue.length}</i></button>
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><span><History size={19} /></span>ประวัติ</button>
        </nav>
      </section>

      {sheet && (
        <div className="sheet-root" onClick={(event) => { if (event.target === event.currentTarget) setSheet(null); }}>
          <div className="sheet-backdrop" onClick={() => setSheet(null)} />
          <section className="remote-sheet" role="dialog" aria-modal="true" aria-labelledby="remoteSheetTitle">
            <button type="button" className="sheet-close" onClick={() => setSheet(null)} aria-label="ปิด"><X size={19} /></button>
            {sheet === "remote" && (
              <>
                <p className="eyebrow">MOBILE REMOTE · LIVE</p>
                <h2 id="remoteSheetTitle"><MarqueeTitle title={current?.title || "รอเพลงแรก"} /></h2>
                <p className="sheet-subtitle">{current ? <span>{current.channelTitle || "YouTube"}</span> : "ยังไม่มีเพลงกำลังเล่น"}</p>
                <div className="remote-primary">
                  <button
                    type="button"
                    className="remote-back"
                    disabled={!current || Boolean(busy)}
                    onClick={handlePrevious}
                    aria-label="ย้อนกลับ"
                    title="ย้อนกลับ / เริ่มเพลงเดิมใหม่"
                  >
                    <SkipBack size={17} />
                  </button>
                  <button
                    type="button"
                    className="remote-play"
                    disabled={!current}
                    onClick={() => updatePlayback({ playing: !room.playback?.playing })}
                    aria-label={room.playback?.playing ? "พักเพลง" : "เล่นเพลงต่อ"}
                  >
                    {room.playback?.playing ? <Pause size={17} /> : <Play size={17} />}
                  </button>
                  <button type="button" className="remote-next" disabled={!current || Boolean(busy)} onClick={skip} aria-label="ข้ามเพลง" title="ข้ามเพลง">
                    <SkipForward size={17} />
                  </button>
                </div>
                <div className="volume-row">
                  <button type="button" disabled={!current} onClick={() => updatePlayback({ muted: !room.playback?.muted })} aria-label={room.playback?.muted ? "เปิดเสียง" : "ปิดเสียง"}>
                    {room.playback?.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
                  </button>
                  <label>ระดับเสียง <output>{volumeDraft ?? room.playback?.volume ?? 75}%</output><input type="range" min="0" max="100" value={volumeDraft ?? room.playback?.volume ?? 75} disabled={!current} onChange={changeVolume} /></label>
                </div>
              </>
            )}
            {sheet === "share" && <><p className="eyebrow">INVITATION · LIVE</p><h2 id="remoteSheetTitle">ชวนเพื่อนเข้าห้อง</h2><p className="sheet-subtitle share-room-id"><RoomIcon size={12} /><span>{session.roomId}</span></p><label className="copy-field">ลิงก์เข้าร่วม<input readOnly value={partyJoinUrlFor(session.roomId, session.joinToken)} /></label><button type="button" className="sheet-action" onClick={shareRoom}><Copy size={16} /> คัดลอก / แชร์ลิงก์</button></>}
            {sheet === "settings" && (
              <>
                <p className="eyebrow"><RoomIcon size={12} /> SESSION · LIVE</p>
                <h2 id="remoteSheetTitle">ข้อมูลห้อง</h2>
                <p className="sheet-subtitle">คุณเข้าร่วมในชื่อ <strong>{session.displayName}</strong>{isPartyLeader ? " · หัวหน้าปาร์ตี้" : ""}</p>
                <div className="session-info">
                  <span><RoomIcon size={12} /></span>
                  <strong>{session.roomId}</strong>
                  <span>สถานะ</span>
                  <strong>{connected ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ"}</strong>
                </div>
                <div className="member-list" aria-label="สมาชิกที่ออนไลน์">
                  <p className="member-list-label"><Users size={14} /> สมาชิกออนไลน์</p>
                  {onlineMembers.length === 0 ? (
                    <p className="member-empty">ยังไม่มีสมาชิกออนไลน์</p>
                  ) : onlineMembers.map((member) => {
                    const isSelf = member.controllerId === session.controllerId;
                    const confirming = kickTarget?.controllerId === member.controllerId;
                    return (
                      <OnlineMemberRow
                        key={member.controllerId}
                        member={member}
                        isSelf={isSelf}
                        canKick={isPartyLeader}
                        revealed={confirming}
                        onReveal={() => setKickTarget(member)}
                        onCancel={() => setKickTarget(null)}
                        onKick={confirmKick}
                      />
                    );
                  })}
                </div>
                <button type="button" className="sheet-danger" onClick={leaveRoom}>ออกจากห้องนี้</button>
              </>
            )}
          </section>
        </div>
      )}
      <Toast message={notice} onClose={() => setNotice("")} />
    </main>
  );
}

function PreviewPartyView() {
  const [fragment] = useState(() => consumeJoinFragment());
  const [session, setSession] = useState(() => {
    const stored = readSession(CONTROLLER_STORAGE_KEY);
    // A fresh QR scan in an existing browser tab always wins over a stale
    // session from another room.
    return stored && fragment.roomId && stored.roomId !== fragment.roomId ? null : stored;
  });
  const [recovery, setRecovery] = useState(() => readControllerRecovery());
  const [recovering, setRecovering] = useState(() => {
    const stored = readSession(CONTROLLER_STORAGE_KEY);
    const cached = readControllerRecovery();
    const sameRoom = !fragment.roomId || !cached?.roomId || cached.roomId === fragment.roomId;
    return !stored && Boolean(cached) && sameRoom;
  });
  const roomId = session?.roomId || fragment.roomId;

  const commitSession = useCallback((result, joinToken, displayName) => {
    const next = {
      roomId: result.roomId,
      token: result.token,
      displayName: result.displayName,
      controllerId: result.controllerId,
      joinToken,
      expiresAt: result.expiresAt,
      searchConfigured: result.searchConfigured
    };
    writeSession(CONTROLLER_STORAGE_KEY, next);
    writeControllerRecovery(next);
    setSession(next);
    setRecovery({ roomId: next.roomId, joinToken: next.joinToken, displayName: next.displayName });
    setRecovering(false);
  }, []);

  const join = useCallback(async (displayName) => {
    const result = await hostedApi.join(fragment.roomId, fragment.joinToken, displayName);
    commitSession(result, fragment.joinToken, displayName);
  }, [commitSession, fragment.joinToken, fragment.roomId]);

  useEffect(() => {
    const fragmentIsDifferentRoom = Boolean(fragment.roomId && recovery?.roomId && fragment.roomId !== recovery.roomId);
    if (session || fragmentIsDifferentRoom || !recovery?.roomId || !recovery.joinToken || !recovery.displayName) return undefined;
    let active = true;
    setRecovering(true);
    hostedApi.join(recovery.roomId, recovery.joinToken, recovery.displayName)
      .then((result) => {
        if (active) commitSession(result, recovery.joinToken, recovery.displayName);
      })
      .catch(() => {
        if (!active) return;
        clearControllerRecovery();
        setRecovery(null);
        setRecovering(false);
      });
    return () => { active = false; };
  }, [commitSession, fragment.joinToken, recovery, session]);

  const revoked = useCallback((code = "") => {
    if (/member_kicked|member_left/.test(String(code))) {
      clearSession(CONTROLLER_STORAGE_KEY);
      setRecovery(null);
      setRecovering(false);
      setSession(null);
      return;
    }
    const recoverable = /controller_session_expired|session_expired|controller_auth_required|\b401\b|\b403\b/i.test(String(code));
    const cachedRecovery = readControllerRecovery();
    const sameRoom = !fragment.roomId || !cachedRecovery?.roomId || cachedRecovery.roomId === fragment.roomId;
    if (recoverable && cachedRecovery && sameRoom) {
      // Keep the join credential, discard only the expired bearer, and mint a
      // fresh controller session automatically. Room rotation/closure errors
      // intentionally take the normal join path instead.
      clearSession(CONTROLLER_STORAGE_KEY, { clearRecovery: false });
      setSession(null);
      setRecovery(cachedRecovery);
      setRecovering(true);
      return;
    }
    clearSession(CONTROLLER_STORAGE_KEY);
    setRecovery(null);
    setRecovering(false);
    setSession(null);
  }, [fragment.roomId]);

  if (!session && recovering) {
    return (
      <main className="mobile-preview preview-functional-app">
        <section className="phone" aria-label="กำลังกู้การเชื่อมต่อห้อง">
          <div className="empty-state"><LoaderCircle className="spin" size={30} /><span>กำลังกู้ห้องเดิม…</span></div>
        </section>
      </main>
    );
  }
  if (!session) return <PreviewJoinView roomId={roomId} joinToken={fragment.joinToken} onJoin={join} />;
  return <PreviewController session={session} onRevoked={revoked} />;
}

export default function DesignPreviewApp() {
  const path = window.location.pathname;
  const isParty = path === "/party" || path.startsWith("/remote") || path === "/mobile.html";
  return isParty ? <PreviewPartyView /> : <PreviewDisplayView />;
}

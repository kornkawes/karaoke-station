import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
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
  SkipForward,
  Star,
  Trash2,
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
const SEARCH_PAGE_SIZE = 15;
const SEARCH_MAX_RESULTS = 30;

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

function PreviewYouTubeStage({ track, onEnded, onError, playback = emptyPreviewRoom.playback }) {
  const mountRef = useRef(null);
  const playerRef = useRef(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const playbackRef = useRef(playback);
  onEndedRef.current = onEnded;
  onErrorRef.current = onError;
  playbackRef.current = playback;
  const trackKey = track ? `${track.queueId || ""}:${track.videoId}` : "";

  useEffect(() => {
    let cancelled = false;
    let ended = false;
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
            target.unloadModule?.("captions");
            const next = playbackRef.current;
            target.setVolume(next.volume);
            if (next.muted) target.mute();
            else target.unMute();
            if (next.playing) target.playVideo();
            else target.pauseVideo();
          },
          onStateChange: ({ data }) => {
            if (cancelled || ended) return;
            if (data === window.YT.PlayerState.PLAYING) setAutoplayBlocked(false);
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
      try {
        playerRef.current?.destroy?.();
      } catch {
        // The iframe may already have been removed by the browser.
      }
      playerRef.current = null;
      if (mountRef.current) mountRef.current.textContent = "";
    };
  }, [trackKey]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
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
        <PreviewYouTubeStage track={room.current} onEnded={advance} onError={reportFailure} playback={room.playback} />

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

function PreviewController({ session, onRevoked }) {
  const [tab, setTab] = useState("search");
  const [filter, setFilter] = useState("all");
  const [room, setRoom] = useState(emptyPreviewRoom);
  const [connected, setConnected] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [nextSearchPageToken, setNextSearchPageToken] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [favorites, setFavorites] = useState(readFavorites);
  const [history, setHistory] = useState([]);
  const [sheet, setSheet] = useState(null);
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
  const searchLoadMoreRef = useRef(null);
  const searchQueryRef = useRef("");
  const searchRunRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const lastLoadedSearchPageTokenRef = useRef("");
  const searchPagesLoadedRef = useRef(0);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => () => clearTimeout(volumeTimer.current), []);

  useEffect(() => connectRoom(session, (event) => {
    if (event.type === "connection") setConnected(event.connected);
    if (event.type === "room") setRoom((previous) => applyPreviewRoomView(event.view, previous));
    if (event.type === "revoked") onRevoked();
  }), [session, onRevoked]);

  useEffect(() => {
    let live = true;
    hostedApi.queue(session.roomId, session.token)
      .then((view) => { if (live) setRoom((previous) => applyPreviewRoomView(view, previous)); })
      .catch((requestError) => {
        if (live && isSessionRevokedError(`${requestError.code} ${requestError.status}`)) onRevoked();
      });
    return () => { live = false; };
  }, [session, onRevoked]);

  useEffect(() => {
    if (tab !== "history") return undefined;
    let live = true;
    hostedApi.history(session.roomId, session.token)
      .then((data) => { if (live) setHistory(data.history || []); })
      .catch(() => {});
    return () => { live = false; };
  }, [room.revision, session, tab]);

  const guard = useCallback(async (operation) => {
    try {
      return await operation();
    } catch (requestError) {
      if (isSessionRevokedError(`${requestError.code} ${requestError.status}`)) onRevoked();
      throw requestError;
    }
  }, [onRevoked]);

  const doSearch = async (event) => {
    event?.preventDefault();
    const value = query.trim();
    if (!value) return;
    const searchRun = searchRunRef.current + 1;
    searchRunRef.current = searchRun;
    setPhase("loading");
    setResults([]);
    setNextSearchPageToken("");
    searchQueryRef.current = value;
    loadingMoreRef.current = false;
    lastLoadedSearchPageTokenRef.current = "";
    searchPagesLoadedRef.current = isDirectYouTubeInput(value) ? 0 : 1;
    setLoadingMore(false);
    try {
      const data = isDirectYouTubeInput(value)
        ? { results: [await guard(() => hostedApi.resolveYouTube(session.roomId, session.token, value))] }
        : await guard(() => hostedApi.search(session.roomId, session.token, value, "both", { limit: SEARCH_PAGE_SIZE }));
      if (searchRun !== searchRunRef.current) return;
      setResults(uniqueSearchResults((data.results || []).map(normalizeTrack).filter(Boolean)).slice(0, SEARCH_PAGE_SIZE));
      setNextSearchPageToken(isDirectYouTubeInput(value) ? "" : String(data.nextPageToken || ""));
      setPhase("done");
    } catch (requestError) {
      if (searchRun !== searchRunRef.current) return;
      setResults([]);
      setPhase("error");
      setNotice(requestError.message || "ค้นหาไม่สำเร็จ");
    }
  };

  const loadMoreSearchResults = useCallback(async () => {
    const pageToken = nextSearchPageToken;
    const searchText = searchQueryRef.current;
    const searchRun = searchRunRef.current;
    if (
      filter !== "all" ||
      phase !== "done" ||
      !pageToken ||
      !searchText ||
      loadingMoreRef.current ||
      pageToken === lastLoadedSearchPageTokenRef.current ||
      searchPagesLoadedRef.current >= 2 ||
      results.length >= SEARCH_MAX_RESULTS
    ) return;

    lastLoadedSearchPageTokenRef.current = pageToken;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const data = await guard(() => hostedApi.search(
        session.roomId,
        session.token,
        searchText,
        "both",
        { limit: SEARCH_PAGE_SIZE, pageToken }
      ));
      if (searchRun !== searchRunRef.current || searchText !== searchQueryRef.current) return;
      const incoming = uniqueSearchResults((data.results || []).map(normalizeTrack).filter(Boolean));
      setResults((previous) => uniqueSearchResults([...previous, ...incoming]).slice(0, SEARCH_MAX_RESULTS));
      searchPagesLoadedRef.current = 2;
      setNextSearchPageToken("");
    } catch (requestError) {
      if (searchRun === searchRunRef.current && searchText === searchQueryRef.current) {
        lastLoadedSearchPageTokenRef.current = "";
        setNotice(requestError.message || "โหลดเพลงเพิ่มไม่สำเร็จ");
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [filter, guard, nextSearchPageToken, phase, results.length, session.roomId, session.token]);

  useEffect(() => {
    const sentinel = searchLoadMoreRef.current;
    if (!sentinel || filter !== "all" || phase !== "done" || !nextSearchPageToken) return undefined;
    const root = sentinel.closest(".phone-content");
    if (typeof IntersectionObserver !== "function") return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMoreSearchResults();
    }, { root, rootMargin: "180px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filter, loadMoreSearchResults, nextSearchPageToken, phase, results.length]);

  const add = async (track) => {
    setBusy(`add:${track.videoId}`);
    try {
      await guard(() => hostedApi.addTrack(session.roomId, session.token, track));
      setNotice(`เพิ่ม “${track.title}” เข้าคิวแล้ว`);
    } catch (requestError) {
      setNotice(requestError.message || "เพิ่มเพลงไม่สำเร็จ");
    } finally {
      setBusy("");
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
              <form className="search-box" onSubmit={doSearch}>
                <input aria-label="ค้นหาชื่อเพลง ศิลปิน หรือลิงก์ YouTube" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ชื่อเพลง, ศิลปิน หรือ YouTube URL" autoComplete="off" />
                <button type="submit" aria-label="ค้นหา"><Search size={20} /></button>
              </form>
              <div className="chips" aria-label="ตัวกรองเพลง">
                <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>ทั้งหมด</button>
                <button type="button" className={filter === "favorites" ? "active" : ""} onClick={() => setFilter("favorites")}>☆ เพลงโปรด ({favorites.length})</button>
              </div>
              <p className="mobile-tip"><strong>Tips</strong> คุณสามารถกดดาวเพื่อเพิ่มเพลงโปรดไว้ในเครื่องได้</p>
              {phase === "loading" && <div className="empty-state"><LoaderCircle className="spin" size={30} /><span>กำลังค้นหาจาก YouTube…</span></div>}
              {phase === "error" && <div className="empty-state"><b>ค้นหาไม่สำเร็จ</b><span>ตรวจลิงก์หรือคำค้น แล้วลองใหม่อีกครั้ง</span></div>}
              {filter === "favorites" && displayedResults.length === 0 && <div className="empty-state"><b>ยังไม่มีเพลงโปรด</b><span>กดดาวที่เพลงเพื่อเก็บไว้ในเครื่องนี้</span></div>}
              {phase === "done" && filter === "all" && displayedResults.length === 0 && !nextSearchPageToken && <div className="empty-state"><b>ไม่พบเพลง</b><span>ลองเพิ่มชื่อศิลปิน หรือวางลิงก์ YouTube โดยตรง</span></div>}
              {displayedResults.length > 0 && <div className="result-heading"><p>{filter === "favorites" ? "เพลงโปรดของฉัน" : "ผลการค้นหา"}</p><small>{displayedResults.length} รายการ</small></div>}
              <ul className="song-list">
                {displayedResults.map((track) => <SongRow key={track.videoId} track={track} favorite={favorites.some((item) => item.videoId === track.videoId)} onFavorite={toggleFavorite} onAdd={add} />)}
                {filter === "all" && nextSearchPageToken && (
                  <li className="search-load-more" ref={searchLoadMoreRef} aria-live="polite">
                    {loadingMore ? <><LoaderCircle className="spin" size={18} /> <span>กำลังโหลดเพลงเพิ่ม…</span></> : <span>เลื่อนลงเพื่อโหลดเพลงเพิ่ม</span>}
                  </li>
                )}
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
                    disabled={!current}
                    onClick={() => updatePlayback({ playing: !room.playback?.playing })}
                    aria-label={room.playback?.playing ? "พักเพลง" : "เล่นเพลงต่อ"}
                  >
                    {room.playback?.playing ? <Pause size={17} /> : <Play size={17} />}
                  </button>
                  <button type="button" disabled={!current || Boolean(busy)} onClick={skip}>
                    <SkipForward size={17} /> ข้ามเพลง
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
            {sheet === "settings" && <><p className="eyebrow"><RoomIcon size={12} /> SESSION · LIVE</p><h2 id="remoteSheetTitle">ข้อมูลห้อง</h2><p className="sheet-subtitle">คุณเข้าร่วมในชื่อ <strong>{session.displayName}</strong></p><div className="session-info"><span><RoomIcon size={12} /></span><strong>{session.roomId}</strong><span>สถานะ</span><strong>{connected ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ"}</strong></div><button type="button" className="sheet-danger" onClick={() => { clearSession(CONTROLLER_STORAGE_KEY); onRevoked(); }}>ออกจากห้องนี้</button></>}
          </section>
        </div>
      )}
      <Toast message={notice} onClose={() => setNotice("")} />
    </main>
  );
}

function PreviewPartyView() {
  const [fragment] = useState(() => consumeJoinFragment());
  const [session, setSession] = useState(() => readSession(CONTROLLER_STORAGE_KEY));
  const roomId = session?.roomId || fragment.roomId;

  const join = async (displayName) => {
    const result = await hostedApi.join(fragment.roomId, fragment.joinToken, displayName);
    const next = {
      roomId: result.roomId,
      token: result.token,
      displayName: result.displayName,
      joinToken: fragment.joinToken,
      expiresAt: result.expiresAt,
      searchConfigured: result.searchConfigured
    };
    writeSession(CONTROLLER_STORAGE_KEY, next);
    setSession(next);
  };

  const revoked = useCallback(() => {
    clearSession(CONTROLLER_STORAGE_KEY);
    setSession(null);
  }, []);

  if (!session) return <PreviewJoinView roomId={roomId} joinToken={fragment.joinToken} onJoin={join} />;
  return <PreviewController session={session} onRevoked={revoked} />;
}

export default function DesignPreviewApp() {
  const path = window.location.pathname;
  const isParty = path === "/party" || path.startsWith("/remote") || path === "/mobile.html";
  return isParty ? <PreviewPartyView /> : <PreviewDisplayView />;
}

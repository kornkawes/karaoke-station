import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  History,
  ListMusic,
  LoaderCircle,
  Maximize2,
  Mic2,
  Minimize2,
  Music2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Share2,
  SkipForward,
  Star,
  Trash2,
  Volume2,
  Wifi,
  WifiOff,
  X
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
  joinUrlFor,
  partyJoinUrlFor,
  normalizeQueue,
  normalizeTrack,
  readSession,
  writeSession
} from "./lib/hosted-api";
import { loadYouTubeIframeApi } from "./lib/youtube";
import "./hosted.css";

const emptyRoomState = {
  revision: 0,
  current: null,
  queue: [],
  stationName: "KaraokeStation",
  settings: { fairQueue: false }
};

const FAVORITES_STORAGE_KEY = "karaoke.favoriteTracks";
const FAVORITE_CLASSIFICATIONS = {
  karaoke: "Karaoke",
  instrumental: "Instrumental",
  backing_track: "Backing Track"
};
const FAVORITE_BADGES = Object.fromEntries(
  Object.entries(FAVORITE_CLASSIFICATIONS).map(([classification, badge]) => [badge, classification])
);
const YOUTUBE_THUMBNAIL_HOSTS = new Set(["i.ytimg.com", "img.youtube.com"]);

function safeFavoriteThumbnail(value, videoId) {
  const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  try {
    const url = new URL(String(value || fallback));
    if (url.protocol === "https:" && YOUTUBE_THUMBNAIL_HOSTS.has(url.hostname.toLowerCase())) {
      return url.toString();
    }
  } catch {
    // Invalid stored values fall back to the known-safe YouTube thumbnail.
  }
  return fallback;
}

export function normalizeFavorite(track) {
  if (!track || typeof track !== "object") return null;
  const videoId = String(track.videoId || "");
  const title = String(track.title || "").trim().slice(0, 300);
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !title) return null;
  const classification = FAVORITE_CLASSIFICATIONS[track.classification]
    ? track.classification
    : FAVORITE_BADGES[track.badge] || null;
  return {
    videoId,
    title,
    channelTitle: String(track.channelTitle || "").trim().slice(0, 200),
    thumbnailUrl: safeFavoriteThumbnail(track.thumbnailUrl, videoId),
    ...(track.duration ? { duration: String(track.duration).slice(0, 32) } : {}),
    ...(classification
      ? { classification, badge: FAVORITE_CLASSIFICATIONS[classification] }
      : {})
  };
}

export function sanitizeFavorites(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeFavorite).filter(Boolean).slice(0, 100);
}

function readFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    return raw ? sanitizeFavorites(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeFavorites(items) {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(sanitizeFavorites(items)));
  } catch {
    // quota exceeded or restricted storage
  }
}

function viewToState(view, previous = {}) {
  const queue = normalizeQueue({ revision: view.revision, current: view.current, items: view.queue });
  return {
    revision: queue.revision,
    current: queue.current,
    queue: queue.items,
    stationName: view.stationName || "KaraokeStation",
    settings: view.settings ?? previous.settings ?? {}
  };
}

function Empty({ title, detail }) {
  return (
    <div className="empty-state">
      <Music2 size={34} />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

function Toast({ message, onClose }) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => onCloseRef.current?.(), 2500);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;
  return (
    <div className="display-toast" role="status">
      <Mic2 size={18} />
      <span>{message}</span>
      <button className="icon-button" aria-label="ปิดข้อความ" onClick={onClose}><X size={16} /></button>
    </div>
  );
}

function HostedPlayer({ track, onEnded, onError, onExitFullscreen, isFullscreen, containerRef, volume = 75 }) {
  const rootRef = useRef(null);
  const playerRef = useRef(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const volumeRef = useRef(volume);
  onEndedRef.current = onEnded;
  onErrorRef.current = onError;
  volumeRef.current = volume;

  useEffect(() => {
    let cancelled = false;
    let ended = false;
    setAutoplayBlocked(false);
    if (!track?.videoId) return undefined;

    const create = () => {
      if (cancelled || !rootRef.current) return;
      const mount = document.createElement("div");
      rootRef.current.appendChild(mount);
      playerRef.current = new window.YT.Player(mount, {
        videoId: track.videoId,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: ({ target }) => {
            target.setVolume(volumeRef.current);
            target.playVideo();
          },
          onStateChange: ({ data }) => {
            if (cancelled || ended) return;
            if (data === window.YT.PlayerState.PLAYING) setAutoplayBlocked(false);
            if (data === window.YT.PlayerState.ENDED) {
              ended = true;
              onEndedRef.current();
            }
          },
          onError: ({ data }) => {
            if (cancelled) return;
            onErrorRef.current(data);
          },
          onAutoplayBlocked: () => {
            if (!cancelled) setAutoplayBlocked(true);
          }
        }
      });
    };

    if (window.YT?.Player) create();
    else loadYouTubeIframeApi().then(create).catch(() => onErrorRef.current("loader"));

    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        // destroy() can throw if the iframe is already gone; nothing to recover.
      }
      playerRef.current = null;
      if (rootRef.current) rootRef.current.textContent = "";
    };
  }, [track?.videoId]);

  const resumeWithSound = () => {
    const player = playerRef.current;
    if (!player) return;
    player.unMute?.();
    player.setVolume?.(volumeRef.current);
    player.playVideo?.();
    setAutoplayBlocked(false);
  };

  return (
    <div className="hosted-video" ref={containerRef}>
      <div className="hosted-video-mount" ref={rootRef} aria-label={track ? `YouTube ${track.title}` : undefined} />
      {!track && <Empty title="รอเพลงแรก" detail="สแกน QR ด้วยมือถือเพื่อค้นหาและเพิ่มเพลง" />}
      {track && autoplayBlocked && (
        <button className="hosted-autoplay-unlock" onClick={resumeWithSound}>
          <Volume2 size={22} />
          <span><strong>แตะเพื่อเปิดเสียง</strong>เบราว์เซอร์หยุดการเล่นอัตโนมัติไว้</span>
        </button>
      )}
      {isFullscreen && (
        <button className="hosted-video-exit-fullscreen" onClick={onExitFullscreen} aria-label="ย่อหน้าจอเพื่อสแกน QR">
          <Minimize2 size={18} />
          <span>ย่อเพื่อสแกน QR</span>
        </button>
      )}
    </div>
  );
}

function DisplayView() {
  const [session, setSession] = useState(() => readSession(HOST_STORAGE_KEY));
  const [room, setRoom] = useState(emptyRoomState);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toastTimer = useRef();
  const videoContainerRef = useRef(null);

  const notify = useCallback((text) => {
    setMessage(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(""), 3_000);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === videoContainerRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await videoContainerRef.current?.requestFullscreen();
    } catch {
      notify("เบราว์เซอร์นี้ไม่อนุญาตให้เปิดเต็มจอ");
    }
  }, [notify]);

  const createRoom = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const created = await hostedApi.createRoom();
      const next = {
        roomId: created.roomId,
        token: created.hostToken,
        joinToken: created.joinToken,
        joinPath: created.joinPath,
        expiresAt: created.expiresAt,
        searchConfigured: created.searchConfigured
      };
      writeSession(HOST_STORAGE_KEY, next);
      setSession(next);
      setRoom(emptyRoomState);
      notify("สร้างห้องใหม่แล้ว");
    } catch (requestError) {
      setError(requestError.message || "สร้างห้องไม่สำเร็จ");
    } finally {
      setCreating(false);
    }
  }, [notify]);

  useEffect(() => {
    if (!session && !creating) void createRoom();
  }, [session, creating, createRoom]);

  useEffect(() => {
    if (!session) return undefined;
    let stop = false;
    hostedApi.room(session.roomId, session.token)
      .then((view) => { if (!stop) setRoom((old) => viewToState(view, old)); })
      .catch((requestError) => {
        if (stop) return;
        if (isSessionRevokedError(`${requestError.code} ${requestError.status}`)) {
          clearSession(HOST_STORAGE_KEY);
          setSession(null);
        }
      });
    return () => { stop = true; };
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    return connectRoom(session, (event) => {
      if (event.type === "connection") setConnected(event.connected);
      if (event.type === "room") setRoom((old) => viewToState(event.view, old));
      if (event.type === "action") {
        const verb = { add: "เพิ่ม", remove: "ลบ", reorder: "ย้าย", skip: "ข้าม", play_now: "เลือกเล่นทันที" }[event.action.action] || "จัดการ";
        notify(`${event.action.actor} ${verb} “${event.action.track?.title || "เพลง"}”`);
      }
      if (event.type === "revoked") {
        clearSession(HOST_STORAGE_KEY);
        setSession(null);
        setConnected(false);
      }
    });
  }, [session, notify]);

  const advance = useCallback(async () => {
    if (!session) return;
    try {
      const result = await hostedApi.advance(session.roomId, session.token, room.revision);
      setRoom((old) => ({ ...old, revision: result.revision }));
    } catch (requestError) {
      if (requestError.status !== 409) notify(requestError.message);
    }
  }, [session, room.revision, notify]);

  const failureCountRef = useRef({ videoId: null, count: 0 });
  const currentVideoIdRef = useRef(null);
  currentVideoIdRef.current = room.current?.videoId ?? null;

  const reportFailure = useCallback(async (code) => {
    if (!session) return;
    const unplayable = {
      2: "player_error",
      5: "player_error",
      100: "private",
      101: "embed_disabled",
      150: "embed_disabled"
    };
    const reason = unplayable[code];
    if (!reason) {
      notify("โหลดวิดีโอไม่สำเร็จ กำลังลองใหม่");
      return;
    }

    const videoId = currentVideoIdRef.current;
    const tally = failureCountRef.current;
    if (tally.videoId !== videoId) failureCountRef.current = { videoId, count: 1 };
    else tally.count += 1;

    if (failureCountRef.current.count < 2) {
      notify("เล่นวิดีโอไม่สำเร็จ กำลังลองอีกครั้ง");
      return;
    }

    try {
      await hostedApi.currentFailure(session.roomId, session.token, reason, `YouTube error ${code}`);
    } catch {
      // resync on next snapshot
    }
  }, [session, notify]);

  if (error) {
    return (
      <main className="hosted-display hosted-display-centered">
        <div className="hosted-stage">
          <Empty title="เปิดห้องไม่สำเร็จ" detail={error} />
          <button className="button primary" onClick={createRoom}>ลองอีกครั้ง</button>
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="hosted-display hosted-display-centered">
        <div className="hosted-stage">
          <p className="loading"><LoaderCircle className="spin" /> กำลังเปิดห้อง…</p>
        </div>
      </main>
    );
  }

  const joinUrl = joinUrlFor(session.joinPath);

  return (
    <main className="hosted-display">
      <div className="hosted-stage">
        <HostedPlayer
          track={room.current}
          onEnded={advance}
          onError={reportFailure}
          onExitFullscreen={toggleFullscreen}
          isFullscreen={isFullscreen}
          containerRef={videoContainerRef}
        />

        <header className="hosted-topbar" aria-label="สถานะจอคาราโอเกะ">
          <div className="hosted-meta-text">
            <p>{room.current ? "กำลังเล่น" : "พร้อมเล่น"}</p>
            <h1 title={room.current?.title || "รอเพลงแรก"}>
              {room.current?.title || "รอเพลงแรก"}
            </h1>
            <span>{room.current?.channelTitle || "สแกน QR เพื่อเลือกเพลง"}</span>
          </div>
          <div className="hosted-status">
            <span className={connected ? "connected" : "disconnected"}>
              {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
              {connected ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ"}
            </span>
            <strong className="hosted-room-code">ห้อง {session.roomId}</strong>
          </div>
          <button className="hosted-fullscreen-button" onClick={toggleFullscreen} aria-label="ขยายเฉพาะวิดีโอเต็มจอ">
            <Maximize2 size={18} />
          </button>
        </header>

        {room.queue[0] && (
          <div className="hosted-next">
            <span>ถัดไป</span>
            <strong>{room.queue[0].title}</strong>
          </div>
        )}
      </div>

      <aside className="hosted-side">
        <span className="hosted-side-kicker">เพิ่มเพลงจากมือถือ</span>
        <QRCodeSVG value={joinUrl} size={160} bgColor="#f7f8fa" fgColor="#101317" />
        <span className="hosted-side-label">สแกนเพื่อเลือกเพลง</span>
        <button className="button secondary" onClick={createRoom}>สร้างห้องใหม่</button>
      </aside>

      {!session.searchConfigured && (
        <p className="hosted-warning" role="status">ระบบค้นหายังไม่พร้อมใช้งาน</p>
      )}
      <Toast message={message} onClose={() => setMessage("")} />
    </main>
  );
}

function JoinForm({ roomId, onJoin }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await onJoin(name.trim());
    } catch (joinError) {
      setError(joinError.message || "เข้าห้องไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="join">
      <Mic2 size={38} />
      <h1>เข้าร่วม KaraokeStation</h1>
      <p>{roomId ? `ห้อง ${roomId} — ใส่ชื่อเพื่อเริ่มเลือกเพลง` : "สแกน QR จากหน้าจอทีวีเพื่อเข้าห้อง"}</p>
      {roomId ? (
        <form onSubmit={submit}>
          <label>
            ชื่อของคุณ
            <input aria-label="ชื่อของคุณ" maxLength="20" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="button primary wide" disabled={loading || name.trim().length < 1}>
            {loading ? "กำลังเข้า…" : "เข้าร่วม"}
          </button>
        </form>
      ) : (
        <Empty title="ต้องสแกน QR ก่อน" detail="ลิงก์เข้าห้องอยู่บนหน้าจอทีวี" />
      )}
    </main>
  );
}

function ResultRow({ track, onAdd, isFavorite, onToggleFavorite }) {
  return (
    <article className="song-result">
      <img src={track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`} alt="" />
      <div>
        {track.badge && <span className="type-badge">{track.badge}</span>}
        <h3>{track.title}</h3>
        <p>{track.channelTitle || "YouTube"}</p>
      </div>
      <div className="result-actions" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        {onToggleFavorite && (
          <button
            className={`icon-button favorite-btn${isFavorite ? " is-favorite" : ""}`}
            aria-label={isFavorite ? "ลบจากเพลงโปรด" : "เพิ่มในเพลงโปรด"}
            title={isFavorite ? "ลบจากเพลงโปรด" : "เพิ่มในเพลงโปรด"}
            onClick={() => onToggleFavorite(track)}
          >
            <Star size={18} fill={isFavorite ? "#fbbf24" : "none"} color={isFavorite ? "#fbbf24" : "currentColor"} />
          </button>
        )}
        <button className="icon-button accent" aria-label={`เพิ่ม ${track.title} เข้าคิว`} onClick={() => onAdd(track)}>
          <Plus size={18} />
        </button>
      </div>
    </article>
  );
}

function ControllerView({ session, onRevoked }) {
  const [tab, setTab] = useState("search");
  const [searchSubTab, setSearchSubTab] = useState("all");
  const [room, setRoom] = useState(emptyRoomState);
  const [connected, setConnected] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [favorites, setFavorites] = useState(readFavorites);
  const [historyItems, setHistoryItems] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [notice, setNotice] = useState("");
  const [reorderMode, setReorderMode] = useState(false);
  const [movingQueueId, setMovingQueueId] = useState("");
  const [fairQueueSaving, setFairQueueSaving] = useState(false);

  useEffect(() => connectRoom(session, (event) => {
    if (event.type === "connection") setConnected(event.connected);
    if (event.type === "room") setRoom((old) => viewToState(event.view, old));
    if (event.type === "revoked") onRevoked();
  }), [session, onRevoked]);

  useEffect(() => {
    let stop = false;
    hostedApi.queue(session.roomId, session.token)
      .then((view) => { if (!stop) setRoom((old) => viewToState(view, old)); })
      .catch((error) => {
        if (!stop && isSessionRevokedError(`${error.code} ${error.status}`)) onRevoked();
      });
    return () => { stop = true; };
  }, [session, onRevoked]);

  // Load history when switching to history tab
  useEffect(() => {
    if (tab !== "history") return undefined;
    let stop = false;
    hostedApi.history(session.roomId, session.token)
      .then((data) => {
        if (!stop) setHistoryItems(data.history || []);
      })
      .catch(() => {});
    return () => { stop = true; };
  }, [tab, session, room.revision]);

  const guard = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      if (isSessionRevokedError(`${error.code} ${error.status}`)) onRevoked();
      throw error;
    }
  };

  const toggleFavorite = (track) => {
    const exists = favorites.some((f) => f.videoId === track.videoId);
    let next;
    if (exists) {
      next = favorites.filter((f) => f.videoId !== track.videoId);
      setNotice(`ลบ “${track.title}” ออกจากเพลงโปรด`);
    } else {
      const fav = normalizeFavorite(track);
      if (!fav) {
        setNotice("เพลงนี้มีข้อมูลไม่ครบ จึงบันทึกเป็นเพลงโปรดไม่ได้");
        return;
      }
      next = [fav, ...favorites];
      setNotice(`บันทึก “${track.title}” เป็นเพลงโปรด ⭐`);
    }
    setFavorites(next);
    writeFavorites(next);
  };

  const search = async (event) => {
    if (event) event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setPhase("loading");

    // Detect YouTube link or ID
    const isDirectLink = /youtube\.com|youtu\.be|^[A-Za-z0-9_-]{11}$/i.test(trimmed);
    if (isDirectLink) {
      try {
        const resolved = await guard(() => hostedApi.resolveYouTube(session.roomId, session.token, trimmed));
        setResults([normalizeTrack(resolved)]);
        setPhase("done");
        return;
      } catch {
        // fallback to normal search
      }
    }

    try {
      const data = await guard(() => hostedApi.search(session.roomId, session.token, trimmed));
      setResults((data.results || []).map(normalizeTrack));
      setPhase("done");
    } catch (error) {
      setNotice(error.message || "ค้นหาไม่สำเร็จ");
      setPhase("error");
    }
  };

  const add = async (track) => {
    try {
      await guard(() => hostedApi.addTrack(session.roomId, session.token, track));
      setNotice(`เพิ่ม “${track.title}” แล้ว`);
    } catch (error) {
      setNotice(error.message || "เพิ่มเพลงไม่สำเร็จ");
    }
  };

  const remove = async (track) => {
    try {
      await guard(() => hostedApi.removeTrack(session.roomId, session.token, track.queueId, room.revision));
      setNotice(`ลบ “${track.title}” แล้ว`);
    } catch (error) {
      setNotice(error.message || "คิวถูกเปลี่ยนโดยคนอื่น ลองใหม่อีกครั้ง");
    }
  };

  const playNow = async (track) => {
    try {
      await guard(() => hostedApi.playNow(session.roomId, session.token, track.queueId, room.revision));
      setNotice(`กำลังเล่น “${track.title}”`);
    } catch (error) {
      setNotice(error.message || "คิวถูกเปลี่ยนโดยคนอื่น ลองใหม่อีกครั้ง");
    }
  };

  const moveQueueItem = async (track, fromIndex, direction) => {
    const toIndex = fromIndex + direction;
    if (toIndex < 0 || toIndex >= room.queue.length || movingQueueId) return;
    setMovingQueueId(track.queueId);
    try {
      const result = await guard(() => hostedApi.reorder(
        session.roomId,
        session.token,
        track.queueId,
        toIndex,
        room.revision
      ));
      const nextQueue = normalizeQueue(result.queue);
      setRoom((old) => old.revision > nextQueue.revision ? old : ({
        ...old,
        revision: nextQueue.revision,
        current: nextQueue.current,
        queue: nextQueue.items
      }));
      setNotice(`ย้าย “${track.title}” ไปคิว ${toIndex + 1} แล้ว`);
    } catch (error) {
      setNotice(error.message || "คิวถูกเปลี่ยนโดยคนอื่น ลองใหม่อีกครั้ง");
    } finally {
      setMovingQueueId("");
    }
  };

  const skip = async () => {
    try {
      await guard(() => hostedApi.skip(session.roomId, session.token, room.revision));
      setNotice("ข้ามเพลงแล้ว");
    } catch (error) {
      setNotice(error.message || "ข้ามเพลงไม่สำเร็จ");
    }
  };

  const toggleFairQueue = async () => {
    if (fairQueueSaving) return;
    const enabled = !Boolean(room.settings?.fairQueue);
    setFairQueueSaving(true);
    try {
      const result = await guard(() => hostedApi.updateSettings(session.roomId, session.token, { fairQueue: enabled }));
      setRoom((old) => ({
        ...old,
        revision: Math.max(old.revision, result.revision ?? old.revision),
        settings: { ...old.settings, ...(result.settings || {}) }
      }));
      setNotice(enabled ? "เปิดคิวผลัดกันร้องแล้ว" : "ปิดคิวผลัดกันร้องแล้ว");
    } catch (error) {
      setNotice(error.message || "เปลี่ยนโหมดคิวไม่สำเร็จ");
    } finally {
      setFairQueueSaving(false);
    }
  };

  const shareRoom = () => {
    const joinUrl = partyJoinUrlFor(session.roomId, session.joinToken);
    if (!joinUrl) {
      setNotice("ลิงก์เชิญหมดอายุแล้ว กรุณาสแกน QR จากจอทีวีอีกครั้ง");
      return;
    }
    if (navigator.share) {
      navigator.share({
        title: "KaraokeStation",
        text: `มาร้องคาราโอเกะด้วยกันที่ห้อง ${session.roomId}! 🎤`,
        url: joinUrl
      }).catch(() => {});
    } else {
      window.open(`https://line.me/R/msg/text/?${encodeURIComponent(`มาร้องคาราโอเกะด้วยกันที่ห้อง ${session.roomId}! 🎤\n${joinUrl}`)}`, "_blank");
    }
  };

  return (
    <main className="party hosted-party">
      <header className="hosted-party-header">
        <span className="party-brand"><Music2 size={18} /> ห้อง {session.roomId}</span>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            className="share-button-line"
            onClick={shareRoom}
            title="แชร์เข้า LINE / Group Chat"
            aria-label="แชร์ลิงก์ห้องเข้า LINE หรือส่งให้เพื่อน"
          >
            <Share2 size={14} /> แชร์ห้อง
          </button>
          <span className={connected ? "connected" : "disconnected"}>
            {connected ? <Wifi size={15} /> : <WifiOff size={15} />} {connected ? "เชื่อมต่อ" : "ขาดการเชื่อมต่อ"}
          </span>
        </div>
      </header>

      <section className="now-playing">
        <span>กำลังเล่นบนทีวี</span>
        <strong>{room.current?.title || "ยังไม่มีเพลง"}</strong>
        <button className="skip-link" onClick={skip} disabled={!room.current}>
          <SkipForward size={16} /> Skip
        </button>
      </section>

      <div className="hosted-mobile-controls">
        <button
          className={`button secondary hosted-fair-queue-mobile-toggle${room.settings?.fairQueue ? " active" : ""}`}
          aria-pressed={Boolean(room.settings?.fairQueue)}
          onClick={toggleFairQueue}
          disabled={fairQueueSaving}
        >
          <ArrowUpDown size={16} />
          {room.settings?.fairQueue ? "คิวผลัดกันร้อง: เปิด" : "เปิดคิวผลัดกันร้อง"}
        </button>
      </div>

      {tab === "search" && (
        <section className="mobile-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
            <h1 style={{ margin: 0 }}>ค้นหาเพลง</h1>
            <div className="search-sub-tabs" role="tablist">
              <button
                className={`search-sub-tab${searchSubTab === "all" ? " active" : ""}`}
                onClick={() => setSearchSubTab("all")}
              >
                ทั้งหมด
              </button>
              <button
                className={`search-sub-tab${searchSubTab === "favorites" ? " active" : ""}`}
                onClick={() => setSearchSubTab("favorites")}
              >
                ⭐ เพลงโปรด ({favorites.length})
              </button>
            </div>
          </div>
          <p>แสดงเฉพาะ Karaoke, Instrumental, Backing Track หรือแปะลิงก์ YouTube</p>

          {searchSubTab === "all" ? (
            <>
              <form onSubmit={search} className="mobile-search">
                <Search size={20} />
                <input
                  aria-label="ค้นหาเพลง"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="ชื่อเพลง, ศิลปิน หรือวางลิงก์ YouTube"
                  autoComplete="off"
                />
                <button className="button primary" type="submit">ค้นหา</button>
              </form>
              <div className="results" aria-live="polite">
                {phase === "idle" && <Empty title="อยากร้องเพลงอะไรดี?" detail="พิมพ์ชื่อเพลงหรือวางลิงก์ YouTube แล้วกดค้นหา" />}
                {phase === "loading" && <p className="loading"><LoaderCircle className="spin" /> กำลังค้นหา…</p>}
                {phase === "done" && results.length === 0 && (
                  <Empty title="ไม่พบคาราโอเกะหรือเพลงประกอบ" detail="ลองเปลี่ยนคำค้น หรือวางลิงก์ YouTube โดยตรง" />
                )}
                {results.map((track) => (
                  <ResultRow
                    key={track.videoId}
                    track={track}
                    onAdd={add}
                    isFavorite={favorites.some((f) => f.videoId === track.videoId)}
                    onToggleFavorite={toggleFavorite}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="results" aria-live="polite">
              {favorites.length === 0 ? (
                <Empty title="ยังไม่มีเพลงโปรด" detail="แตะไอคอนรูปดาว ⭐ ที่เพลงใดก็ได้เพื่อเก็บไว้ร้องประจำ" />
              ) : (
                favorites.map((track) => (
                  <ResultRow
                    key={track.videoId}
                    track={track}
                    onAdd={add}
                    isFavorite={true}
                    onToggleFavorite={toggleFavorite}
                  />
                ))
              )}
            </div>
          )}
        </section>
      )}

      {tab === "queue" && (
        <section className={`mobile-section queue-tab${reorderMode ? " reorder-mode" : ""}`}>
          <div className="queue-heading">
            <h1>คิวเพลง <span>({room.queue.length})</span></h1>
            <button
              className={`button queue-reorder-toggle${reorderMode ? " active" : ""}`}
              aria-pressed={reorderMode}
              disabled={!reorderMode && room.queue.length < 2}
              onClick={() => setReorderMode((active) => !active)}
            >
              <ArrowUpDown size={16} /> {reorderMode ? "เสร็จสิ้น" : "สลับคิว"}
            </button>
          </div>
          <p>{reorderMode ? "กดลูกศรเพื่อเลื่อนเพลงขึ้นหรือลงในคิว" : "ทุกคนลบ ข้าม เล่นทันที หรือสลับลำดับคิวได้"}</p>
          {room.queue.length ? (
            <ol aria-label="รายการเพลงรอคิว">
              {room.queue.map((track, index) => (
                <li key={track.queueId}>
                  <span>{index + 1}</span>
                  <img src={track.thumbnailUrl} alt="" />
                  <div>
                    <strong>{track.title}</strong>
                    <small>{track.requestedBy || track.channelTitle}</small>
                  </div>
                  <div className="queue-row-actions">
                    {reorderMode ? (
                      <>
                        <button
                          className="icon-button reorder-arrow"
                          aria-label={`ย้าย ${track.title} ขึ้น`}
                          disabled={index === 0 || Boolean(movingQueueId)}
                          onClick={() => moveQueueItem(track, index, -1)}
                        >
                          <ArrowUp size={17} />
                        </button>
                        <button
                          className="icon-button reorder-arrow"
                          aria-label={`ย้าย ${track.title} ลง`}
                          disabled={index === room.queue.length - 1 || Boolean(movingQueueId)}
                          onClick={() => moveQueueItem(track, index, 1)}
                        >
                          <ArrowDown size={17} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="icon-button" aria-label={`เล่น ${track.title} ทันที`} onClick={() => playNow(track)}>
                          <Play size={17} />
                        </button>
                        <button className="icon-button" aria-label={`ลบ ${track.title}`} onClick={() => remove(track)}>
                          <Trash2 size={17} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <Empty title="คิวว่าง" detail="ไปที่แท็บค้นหาเพื่อเพิ่มเพลงต่อไป" />
          )}
        </section>
      )}

      {tab === "history" && (
        <section className="mobile-section history-tab">
          <div className="queue-heading">
            <h1>ประวัติเพลงที่ร้องไปแล้ว <span>({historyItems.length})</span></h1>
          </div>
          <p>รายการเพลงที่เล่นจบหรือถูกข้ามในรอบนี้</p>
          {historyItems.length ? (
            <ol aria-label="รายการประวัติเพลง" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "10px" }}>
              {historyItems.map((track, idx) => (
                <li key={track.id || `${track.videoId}-${idx}`} style={{ display: "grid", gridTemplateColumns: "72px minmax(0, 1fr) auto", alignItems: "center", gap: "10px", padding: "8px", border: "1px solid var(--warm)", borderRadius: "12px", background: "var(--surface)" }}>
                  <img src={track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`} alt="" style={{ width: "72px", height: "41px", objectFit: "cover", borderRadius: "6px" }} />
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: "14px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{track.title}</strong>
                    <small style={{ color: "var(--muted)", fontSize: "12px" }}>
                      {track.status === "completed" ? "✅ จบแล้ว" : track.status === "skipped" ? "⏭️ ข้าม" : "⏹️ หยุดก่อนจบ"}
                      {track.requestedBy && ` • โดย ${track.requestedBy}`}
                    </small>
                  </div>
                  <button
                    className="icon-button accent"
                    style={{ width: "36px", height: "36px" }}
                    aria-label={`ร้องเพลง ${track.title} อีกครั้ง`}
                    title="ร้องอีกครั้ง"
                    onClick={() => add(track)}
                  >
                    <RotateCcw size={16} />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <Empty title="ยังไม่มีประวัติเพลง" detail="เมื่อร้องเพลงจบแล้ว เพลงจะปรากฏที่นี่เพื่อให้กดร้องซ้ำได้ง่าย" />
          )}
        </section>
      )}

      <nav className="bottom-tabs" aria-label="เมนูมือถือ">
        <button className={tab === "search" ? "active" : ""} onClick={() => { setTab("search"); setReorderMode(false); }}>
          <Search /> ค้นหา
        </button>
        <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
          <ListMusic /> คิว {room.queue.length > 0 ? `(${room.queue.length})` : ""}
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          <History /> ประวัติ {historyItems.length > 0 ? `(${historyItems.length})` : ""}
        </button>
      </nav>

      <Toast message={notice} onClose={() => setNotice("")} />
    </main>
  );
}

function PartyView() {
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
      expiresAt: result.expiresAt
    };
    writeSession(CONTROLLER_STORAGE_KEY, next);
    setSession(next);
  };

  const revoked = useCallback(() => {
    clearSession(CONTROLLER_STORAGE_KEY);
    setSession(null);
  }, []);

  if (!session) return <JoinForm roomId={roomId} onJoin={join} />;
  return <ControllerView session={session} onRevoked={revoked} />;
}

export default function HostedApp() {
  const isParty = window.location.pathname === "/party" || window.location.pathname.startsWith("/remote");
  return isParty ? <PartyView /> : <DisplayView />;
}

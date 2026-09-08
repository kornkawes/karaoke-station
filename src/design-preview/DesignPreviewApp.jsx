import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  History,
  ListMusic,
  LoaderCircle,
  Maximize2,
  Mic2,
  Pause,
  Play,
  Plus,
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
  normalizeTrack,
  readSession,
  writeSession
} from "../lib/hosted-api";
import { loadYouTubeIframeApi } from "../lib/youtube";
import stageImage from "../../design-preview/assets/stage.png";
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

function Toast({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="toast show" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" className="icon-button" aria-label="ปิดข้อความ" onClick={onClose}><X size={16} /></button>
    </div>
  );
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
        playerVars: { autoplay: playbackRef.current.playing ? 1 : 0, playsinline: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: ({ target }) => {
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
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stageRef = useRef(null);
  const failureRef = useRef({ videoId: "", count: 0 });

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const createRoom = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const previous = session;
      if (previous?.roomId && previous?.token) {
        await hostedApi.closeRoom(previous.roomId, previous.token).catch(() => {});
      }
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
      setRoom(emptyPreviewRoom);
      setConnected(false);
      setNotice("เปิดห้องใหม่แล้ว");
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
        if (live) setRoom((previous) => applyPreviewRoomView(view, previous));
      })
      .catch((requestError) => {
        if (!live) return;
        if (isSessionRevokedError(`${requestError.code} ${requestError.status}`)) {
          clearSession(HOST_STORAGE_KEY);
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
      if (event.type === "connection") setConnected(event.connected);
      if (event.type === "room") setRoom((previous) => applyPreviewRoomView(event.view, previous));
      if (event.type === "action" && event.action?.action === "add") {
        setNotice(`เพิ่ม “${event.action.track?.title || "เพลง"}” แล้ว`);
      }
      if (event.type === "revoked") {
        clearSession(HOST_STORAGE_KEY);
        setSession(null);
        setConnected(false);
      }
    });
  }, [session]);

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

  const copyJoinLink = useCallback(async () => {
    if (!session) return;
    const joinUrl = joinUrlFor(session.joinPath);
    try {
      await navigator.clipboard.writeText(joinUrl);
      setNotice("คัดลอกลิงก์เข้าห้องแล้ว");
    } catch {
      setNotice("คัดลอกไม่ได้ แต่ QR ด้านซ้ายใช้เข้าห้องได้จริง");
    }
  }, [session]);

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
  const joinUrl = joinUrlFor(session.joinPath);
  return (
    <main className="host-display-page preview-functional-host">
      <section
        ref={stageRef}
        className="display-stage"
        aria-label={room.current ? `จอเพลงจริง · ${room.current.title}` : "จอเพลงจริง · รอเพลงแรก"}
      >
        <PreviewYouTubeStage track={room.current} onEnded={advance} onError={reportFailure} playback={room.playback} />

        <aside className="join-corner" aria-label="ข้อมูลห้องจริง">
          <div className="real-qr"><QRCodeSVG value={joinUrl} size={84} bgColor="#f5f1e8" fgColor="#050607" /></div>
          <div className="join-copy">
            <p>ROOM <strong>{session.roomId}</strong></p>
            <small>SCAN TO JOIN · LIVE ROOM</small>
            <span>{connected ? "เชื่อมต่อกับเซิร์ฟเวอร์แล้ว" : "กำลังเชื่อมต่อเซิร์ฟเวอร์"}</span>
            <div className="host-actions">
              <button type="button" onClick={copyJoinLink}><Copy size={13} /> คัดลอกลิงก์</button>
              <button type="button" onClick={createRoom} disabled={creating}><RotateIcon /> ห้องใหม่</button>
            </div>
          </div>
        </aside>

        <aside className="next-song" aria-label="เพลงถัดไป">
          <p>UP NEXT · {room.queue.length} เพลง</p>
          <strong>{next?.title || (room.current ? "ยังไม่มีเพลงถัดไป" : "รอเพลงแรก")}</strong>
          <span>{next ? `${next.channelTitle || "YouTube"} · ${next.requestedBy || "สมาชิกในห้อง"}` : "เพิ่มเพลงจากมือถือ"}</span>
        </aside>

        <div className="display-controls" data-controls>
          <button type="button" className="fullscreen-control" onClick={toggleFullscreen} aria-label="เข้าสู่โหมดเต็มหน้าจอ">
            <Maximize2 size={17} />
            <span className="control-label">FULL SCREEN</span>
          </button>
        </div>
      </section>
      <Toast message={notice} onClose={() => setNotice("")} />
    </main>
  );
}

function RotateIcon() {
  return <span aria-hidden="true" className="rotate-icon">↻</span>;
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
      <div className="desktop-context"><a href="/">← กลับหน้าจอแสดงผล</a><p>LIVE MOBILE REMOTE<br />SCAN QR FROM HOST</p></div>
      <section className="phone join-phone" aria-label="เข้าห้อง Karaoke Station" inert>
        <header className="phone-header">
          <div><a className="wordmark" href="/">KARAOKE STATION <i>AFTER HOURS</i></a><p><span className="status-dot" /> {roomId || "—"} · LIVE ROOM</p></div>
          <div className="header-actions">
            <button type="button" className="share-button svg-button" onClick={shareInvite} disabled={!inviteUrl} aria-label="เปิดคำเชิญห้อง"><Share2 size={16} /><span>แชร์</span></button>
            <button type="button" className="settings-button svg-button" disabled aria-label="ตั้งค่าห้อง"><Settings size={18} /></button>
          </div>
        </header>
        <section className="phone-content" aria-live="polite">
          <section className="mobile-hero"><p className="eyebrow">KARAOKE STATION <span className="preview-label">· LIVE ROOM</span></p><h1>คืนนี้<br /><em>ร้องเพลงไหนดี?</em></h1></section>
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
        <section className="remote-sheet compact-sheet" role="dialog" aria-modal="true" aria-labelledby="joinTitle">
          <p className="eyebrow">JOIN ROOM · LIVE</p>
          <h2 id="joinTitle">เข้าห้อง {roomId || "—"}</h2>
          <p className="sheet-subtitle">ใส่ชื่อที่จะใช้ขอเพลง</p>
          {roomId && joinToken ? (
            <form id="joinForm" onSubmit={submit}>
              <label className="copy-field">ชื่อของคุณ<input autoFocus maxLength={20} value={name} onChange={(event) => setName(event.target.value)} placeholder="เช่น Nut" /></label>
              {error && <p className="form-error">{error}</p>}
              <button type="submit" className="sheet-action" disabled={loading || !name.trim()}>{loading ? "กำลังเข้าห้อง…" : "เข้าร่วมห้องจริง"}</button>
            </form>
          ) : (
            <div className="empty-state"><b>ต้องสแกน QR จากจอ Host</b><span>ลิงก์นี้ไม่มีข้อมูลเข้าห้องที่ปลอดภัย</span></div>
          )}
          <p className="sheet-note">ใส่ชื่อเพื่อเข้าร่วมห้องจริงและเลือกเพลงจากมือถือ</p>
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
        <strong>{track.title}</strong>
        <small>{track.channelTitle || "YouTube"}</small>
        <span>{track.duration || ""} · กด + เพื่อเข้าคิวจริง</span>
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

function PreviewController({ session, onRevoked }) {
  const [tab, setTab] = useState("search");
  const [filter, setFilter] = useState("all");
  const [room, setRoom] = useState(emptyPreviewRoom);
  const [connected, setConnected] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [favorites, setFavorites] = useState(readFavorites);
  const [history, setHistory] = useState([]);
  const [reorderMode, setReorderMode] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [fairSaving, setFairSaving] = useState(false);
  const [playbackSaving, setPlaybackSaving] = useState(false);
  const [volumeDraft, setVolumeDraft] = useState(null);
  const playbackPending = useRef(null);
  const playbackMutating = useRef(false);
  const volumeTimer = useRef(null);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 3_000);
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

  const guard = async (operation) => {
    try {
      return await operation();
    } catch (requestError) {
      if (isSessionRevokedError(`${requestError.code} ${requestError.status}`)) onRevoked();
      throw requestError;
    }
  };

  const doSearch = async (event) => {
    event?.preventDefault();
    const value = query.trim();
    if (!value) return;
    setPhase("loading");
    try {
      const data = isDirectYouTubeInput(value)
        ? { results: [await guard(() => hostedApi.resolveYouTube(session.roomId, session.token, value))] }
        : await guard(() => hostedApi.search(session.roomId, session.token, value));
      setResults((data.results || []).map(normalizeTrack).filter(Boolean));
      setPhase("done");
    } catch (requestError) {
      setResults([]);
      setPhase("error");
      setNotice(requestError.message || "ค้นหาไม่สำเร็จ");
    }
  };

  const add = async (track) => {
    setBusy(`add:${track.videoId}`);
    try {
      await guard(() => hostedApi.addTrack(session.roomId, session.token, track));
      setNotice(`เพิ่ม “${track.title}” เข้าคิวจริงแล้ว`);
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

  const move = async (track, index, direction) => {
    const toIndex = index + direction;
    if (toIndex < 0 || toIndex >= room.queue.length || busy) return;
    setBusy(`move:${track.queueId}`);
    try {
      await guard(() => hostedApi.reorder(session.roomId, session.token, track.queueId, toIndex, room.revision));
    } catch (requestError) {
      setNotice(requestError.message || "ย้ายคิวไม่สำเร็จ");
    } finally {
      setBusy("");
    }
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

  const complete = async () => {
    if (!room.current || busy) return;
    const targetQueueId = room.current.queueId;
    setBusy("complete");
    try {
      // Synchronize before the mutation so a delayed initial snapshot cannot leave
      // the controller holding an obsolete revision.
      const latest = await guard(() => hostedApi.queue(session.roomId, session.token));
      const latestRoom = applyPreviewRoomView(latest, room);
      setRoom(latestRoom);
      if (!latestRoom.current || latestRoom.current.queueId !== targetQueueId) {
        setNotice("คิวเปลี่ยนไปแล้ว กรุณาลองใหม่");
        return;
      }

      let result;
      try {
        result = await guard(() => hostedApi.complete(session.roomId, session.token, latestRoom.revision));
      } catch (requestError) {
        if (requestError.status !== 409) throw requestError;

        // A second client can still win the small gap between the refresh and the
        // mutation. Retry only if the same song remains current after refreshing.
        const retryView = await guard(() => hostedApi.queue(session.roomId, session.token));
        const retryRoom = applyPreviewRoomView(retryView, latestRoom);
        setRoom(retryRoom);
        if (!retryRoom.current || retryRoom.current.queueId !== targetQueueId) {
          throw requestError;
        }
        result = await guard(() => hostedApi.complete(session.roomId, session.token, retryRoom.revision));
      }
      if (result?.queue) {
        setRoom((previous) => applyPreviewRoomView(result.queue, previous));
      }
      // Read back the full authoritative room, including playback reset, rather
      // than waiting for a socket event to arrive in the browser.
      const authoritative = await guard(() => hostedApi.queue(session.roomId, session.token));
      setRoom((previous) => applyPreviewRoomView(authoritative, previous));
      setNotice("จบเพลงแล้ว");
    } catch (requestError) {
      setNotice(requestError.message || "จบเพลงไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const toggleFairQueue = async () => {
    if (fairSaving) return;
    setFairSaving(true);
    const enabled = !Boolean(room.settings?.fairQueue);
    try {
      await guard(() => hostedApi.updateSettings(session.roomId, session.token, { fairQueue: enabled }));
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
    setPlaybackSaving(true);
    try {
      await guard(() => hostedApi.updatePlayback(session.roomId, session.token, patch));
    } catch (requestError) {
      setNotice(requestError.message || "เปลี่ยนการเล่นไม่สำเร็จ");
    } finally {
      playbackMutating.current = false;
      if (playbackPending.current) void flushPlayback();
      else setPlaybackSaving(false);
    }
  };

  const updatePlayback = (patch) => {
    if (!current) return;
    playbackPending.current = { ...(playbackPending.current || {}), ...patch };
    void flushPlayback();
  };

  const changeVolume = (event) => {
    const volume = Number(event.target.value);
    setVolumeDraft(volume);
    clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(() => {
      setVolumeDraft(null);
      updatePlayback({ volume });
    }, 240);
  };

  const shareRoom = async () => {
    const url = partyJoinUrlFor(session.roomId, session.joinToken);
    try {
      if (navigator.share) await navigator.share({ title: "Karaoke Station", text: `เข้าห้อง ${session.roomId}`, url });
      else await navigator.clipboard.writeText(url);
      setNotice("ลิงก์เข้าห้องจริงพร้อมส่งให้เพื่อนแล้ว");
    } catch {
      setNotice("ยังไม่ได้แชร์ลิงก์");
    }
  };

  const favoriteResults = useMemo(() => favorites.map(normalizeTrack).filter(Boolean), [favorites]);
  const displayedResults = filter === "favorites" ? favoriteResults : results;
  const current = room.current;

  return (
    <main className="mobile-preview preview-functional-app">
      <div className="desktop-context"><a href="/">← กลับหน้าจอ Host</a><p>LIVE MOBILE REMOTE<br />REAL ROOM · SOCKET SYNC</p></div>
      <section className="phone" aria-label="Karaoke Station mobile remote">
        <header className="phone-header">
          <div>
            <a className="wordmark" href="/">KARAOKE STATION <i>AFTER HOURS</i></a>
            <p><span className={`status-dot ${connected ? "is-online" : ""}`} /> {session.roomId} · {connected ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ"}</p>
          </div>
          <div className="header-actions">
            <button type="button" className="share-button svg-button" onClick={() => setSheet("share")} aria-label="เปิดคำเชิญห้อง"><Share2 size={16} /><span>แชร์</span></button>
            <button type="button" className="settings-button svg-button" onClick={() => setSheet("settings")} aria-label="ดูข้อมูลห้อง"><Settings size={18} /></button>
          </div>
        </header>

        <section className="phone-content" aria-live="polite">
          {tab === "search" && (
            <>
              <section className="mobile-hero"><p className="eyebrow">KARAOKE STATION <span className="preview-label">· LIVE ROOM</span></p><h1>คืนนี้<br /><em>ร้องเพลงไหนดี?</em></h1></section>
              <form className="search-box" onSubmit={doSearch}>
                <input aria-label="ค้นหาชื่อเพลง ศิลปิน หรือลิงก์ YouTube" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ชื่อเพลง, ศิลปิน หรือ YouTube URL" autoComplete="off" />
                <button type="submit" aria-label="ค้นหา"><Search size={20} /></button>
              </form>
              <div className="chips" aria-label="ตัวกรองเพลง">
                <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>ทั้งหมด</button>
                <button type="button" className={filter === "favorites" ? "active" : ""} onClick={() => setFilter("favorites")}>☆ เพลงโปรด ({favorites.length})</button>
              </div>
              {phase === "loading" && <div className="empty-state"><LoaderCircle className="spin" size={30} /><span>กำลังค้นหาจาก YouTube…</span></div>}
              {phase === "error" && <div className="empty-state"><b>ค้นหาไม่สำเร็จ</b><span>ตรวจลิงก์หรือคำค้น แล้วลองใหม่อีกครั้ง</span></div>}
              {filter === "favorites" && displayedResults.length === 0 && <div className="empty-state"><b>ยังไม่มีเพลงโปรด</b><span>กดดาวที่เพลงเพื่อเก็บไว้ในเครื่องนี้</span></div>}
              {filter === "all" && phase === "idle" && <div className="empty-state"><b>ค้นหาเพลงที่จะร้อง</b><span>ผลลัพธ์มาจาก YouTube จริง และปุ่ม + จะเพิ่มเข้าคิวห้องนี้</span></div>}
              {phase === "done" && filter === "all" && displayedResults.length === 0 && <div className="empty-state"><b>ไม่พบเพลง</b><span>ลองเพิ่มชื่อศิลปิน หรือวางลิงก์ YouTube โดยตรง</span></div>}
              {displayedResults.length > 0 && <div className="result-heading"><p>{filter === "favorites" ? "เพลงโปรดของฉัน" : "ผลการค้นหา"}</p><small>{displayedResults.length} รายการ</small></div>}
              <ul className="song-list">
                {displayedResults.map((track) => <SongRow key={track.videoId} track={track} favorite={favorites.some((item) => item.videoId === track.videoId)} onFavorite={toggleFavorite} onAdd={add} />)}
              </ul>
              <p className="live-callout"><strong>LIVE ROOM</strong> · เพิ่มเพลงแล้วทุกอุปกรณ์ในห้องจะเห็นคิวเดียวกันทันที</p>
            </>
          )}

          {tab === "queue" && (
            <>
              <section className="queue-title"><div><p className="eyebrow">LIVE ROOM</p><h1>คิวของเรา</h1></div><p>{room.queue.length} เพลง</p></section>
              <section className="fair-toggle"><div><strong>ผลัดกันร้อง</strong><small>{room.settings?.fairQueue ? "เปิดอยู่ · ระบบกระจายคิวตามผู้ขอ" : "ปิดอยู่ · จัดลำดับเองได้"}</small></div><button type="button" className={`switch ${room.settings?.fairQueue ? "on" : ""}`} onClick={toggleFairQueue} disabled={fairSaving} aria-pressed={Boolean(room.settings?.fairQueue)}><i /></button></section>
              <div className="queue-toolbar"><span>{reorderMode ? "กดลูกศรเพื่อย้ายเพลง" : "คิวนี้เป็นของห้องจริง"}</span><button type="button" onClick={() => setReorderMode((value) => !value)} disabled={room.queue.length < 2}>{reorderMode ? "เสร็จสิ้น" : "สลับคิว"}</button></div>
              <section className="queue-list">
                {room.queue.length === 0 && <div className="empty-state"><b>คิวว่างอยู่</b><span>กลับไปค้นหาเพลงที่อยากร้องได้เลย</span></div>}
                {room.queue.map((track, index) => (
                  <article className="queue-item" key={track.queueId}>
                    <span className="queue-pos">{String(index + 1).padStart(2, "0")}</span>
                    <Cover track={track} />
                    <div><strong>{track.title}</strong><small>{track.channelTitle || "YouTube"} · ขอโดย {track.requestedBy || "สมาชิก"}</small><div className="queue-controls">
                      {reorderMode ? <><button type="button" onClick={() => move(track, index, -1)} disabled={index === 0 || Boolean(busy)} aria-label="เลื่อนขึ้น">↑</button><button type="button" onClick={() => move(track, index, 1)} disabled={index === room.queue.length - 1 || Boolean(busy)} aria-label="เลื่อนลง">↓</button></> : <><button type="button" className="play-now" onClick={() => playNow(track)} disabled={Boolean(busy)}><Play size={13} /> เล่นทันที</button><button type="button" className="remove" onClick={() => remove(track)} disabled={Boolean(busy)} aria-label="ลบเพลง"><Trash2 size={15} /></button></>}
                    </div></div>
                  </article>
                ))}
              </section>
            </>
          )}

          {tab === "history" && (
            <>
              <section className="history-title"><p className="eyebrow">THE GOOD PARTS</p><h1>ประวัติการร้อง</h1><p>ห้องนี้ · {history.length} เพลง</p></section>
              <section className="history-list">
                {history.length === 0 && <div className="empty-state"><b>ยังไม่มีประวัติ</b><span>เพลงที่จบหรือถูกข้ามจะปรากฏที่นี่</span></div>}
                {history.map((item, index) => {
                  const track = normalizeTrack(item);
                  return <article className="history-row" key={item.id || `${item.videoId}-${index}`}><Cover track={track} /><div><strong>{track.title}</strong><small>{track.channelTitle || "YouTube"} · {item.status === "completed" ? "ร้องจบแล้ว" : item.status === "skipped" ? "ข้ามแล้ว" : "หยุดก่อนจบ"}</small></div><button type="button" className="readd" onClick={() => add(track)} disabled={busy === `add:${track.videoId}`}><Plus size={14} /> ร้องอีก</button></article>;
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
            disabled={!current || playbackSaving || Boolean(busy)}
            aria-label={room.playback?.playing ? "พักเพลง" : "เล่นเพลงต่อ"}
          >
            {room.playback?.playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button type="button" className="dock-details" onClick={() => setSheet("remote")}><span>{current ? "กำลังเล่นบนทีวี" : "WAITING"}</span><strong>{current?.title || "รอเพลงแรก"}</strong><small>{current ? `${current.channelTitle || "YouTube"} · ${current.requestedBy || "สมาชิก"}` : "เพิ่มเพลงจากหน้าค้นหาได้เลย"}</small></button>
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
          <section className="remote-sheet" role="dialog" aria-modal="true">
            <button type="button" className="sheet-close" onClick={() => setSheet(null)} aria-label="ปิด"><X size={19} /></button>
            {sheet === "remote" && (
              <>
                <p className="eyebrow">MOBILE REMOTE · LIVE</p>
                <h2>{current?.title || "รอเพลงแรก"}</h2>
                <p className="sheet-subtitle">{current ? `${current.channelTitle || "YouTube"} · ห้อง ${session.roomId}` : "ยังไม่มีเพลงกำลังเล่น"}</p>
                <div className="remote-primary">
                  <button
                    type="button"
                    disabled={!current || playbackSaving}
                    onClick={() => updatePlayback({ playing: !room.playback?.playing })}
                    aria-label={room.playback?.playing ? "พักเพลง" : "เล่นเพลงต่อ"}
                  >
                    {room.playback?.playing ? <Pause size={17} /> : <Play size={17} />}
                  </button>
                  <button type="button" disabled={!current || Boolean(busy)} onClick={skip}>
                    <SkipForward size={17} /> ข้ามเพลง
                  </button>
                  <button type="button" disabled={!current || Boolean(busy)} onClick={complete}>
                    <Check size={17} /> จบเพลง
                  </button>
                </div>
                <div className="volume-row">
                  <button type="button" disabled={!current || playbackSaving} onClick={() => updatePlayback({ muted: !room.playback?.muted })} aria-label={room.playback?.muted ? "เปิดเสียง" : "ปิดเสียง"}>
                    {room.playback?.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
                  </button>
                  <label>ระดับเสียง <output>{volumeDraft ?? room.playback?.volume ?? 75}%</output><input type="range" min="0" max="100" value={volumeDraft ?? room.playback?.volume ?? 75} disabled={!current || playbackSaving} onChange={changeVolume} /></label>
                </div>
                <p className="sheet-note">คำสั่งเล่น เสียง และคิวส่งเข้าจอ Host ของห้องนี้จริง</p>
              </>
            )}
            {sheet === "share" && <><p className="eyebrow">INVITATION · LIVE</p><h2>ชวนเพื่อนเข้าห้อง</h2><p className="sheet-subtitle">ห้อง {session.roomId} · ลิงก์นี้มี join token ใน fragment ที่ไม่ถูกส่งไปกับ request</p><label className="copy-field">ลิงก์เข้าร่วม<input readOnly value={partyJoinUrlFor(session.roomId, session.joinToken)} /></label><button type="button" className="sheet-action" onClick={shareRoom}><Copy size={16} /> คัดลอก / แชร์ลิงก์จริง</button></>}
            {sheet === "settings" && <><p className="eyebrow">ROOM SESSION · LIVE</p><h2>ข้อมูลห้อง</h2><p className="sheet-subtitle">คุณเข้าร่วมในชื่อ <strong>{session.displayName}</strong></p><div className="session-info"><span>ROOM</span><strong>{session.roomId}</strong><span>สถานะ</span><strong>{connected ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ"}</strong></div><button type="button" className="sheet-danger" onClick={() => { clearSession(CONTROLLER_STORAGE_KEY); onRevoked(); }}>ออกจากห้องนี้</button></>}
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

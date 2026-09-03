import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Flame,
  Globe,
  Layers,
  ListMusic,
  LoaderCircle,
  Maximize2,
  Mic,
  Mic2,
  Minimize2,
  Music,
  Music2,
  Pause,
  Play,
  Plus,
  QrCode,
  Radio,
  RotateCcw,
  Search,
  Share2,
  SkipForward,
  Sparkles,
  Trash2,
  User,
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
  normalizeQueue,
  normalizeTrack,
  readSession,
  writeSession
} from "../lib/hosted-api";
import { karaokeApi } from "../lib/api";
import { loadYouTubeIframeApi } from "../lib/youtube";
import "./modern.css";

const emptyRoomState = {
  revision: 0,
  current: null,
  queue: [],
  stationName: "KaraokeStation",
  settings: { fairQueue: false }
};

const GENRE_CHIPS = [
  { label: "🔥 เพลงฮิต", query: "เพลงฮิต คาราโอเกะ" },
  { label: "🇹🇭 คาราโอเกะไทย", query: "คาราโอเกะ เพลงไทย" },
  { label: "🌍 เพลงสากล", query: "karaoke pop songs" },
  { label: "🎸 ร็อค / ยุค 90s", query: "คาราโอเกะ เพลงยุค 90" },
  { label: "🎤 ลูกทุ่งเพื่อชีวิต", query: "คาราโอเกะ ลูกทุ่ง" },
  { label: "🌸 Anime / J-POP", query: "karaoke anime songs" }
];

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

function timecode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/* ==========================================================================
   Common Shared Components
   ========================================================================== */

function Equalizer() {
  return (
    <div className="m-equalizer" aria-hidden="true">
      <div className="m-equalizer-bar" />
      <div className="m-equalizer-bar" />
      <div className="m-equalizer-bar" />
      <div className="m-equalizer-bar" />
    </div>
  );
}

function Toast({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="m-toast" role="status">
      <Sparkles size={18} className="text-cyan" />
      <span>{message}</span>
      <button className="m-btn-icon" style={{ width: "1.75rem", height: "1.75rem" }} onClick={onClose} aria-label="ปิด">
        <X size={14} />
      </button>
    </div>
  );
}

function ConfirmModal({ title, detail, onConfirm, onCancel, confirmText = "ยืนยัน", danger = false }) {
  return (
    <div className="m-modal-backdrop" onClick={onCancel}>
      <div className="m-modal-content" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="m-join-icon" style={{ width: "3.5rem", height: "3.5rem", marginBottom: "1rem" }}>
          {danger ? <Trash2 size={24} /> : <SkipForward size={24} />}
        </div>
        <h3>{title}</h3>
        <p>{detail}</p>
        <div className="m-modal-actions">
          <button className="m-btn m-btn-secondary" onClick={onCancel}>ยกเลิก</button>
          <button className={`m-btn ${danger ? "m-btn-danger" : "m-btn-primary"}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   1. Display View (TV / Main Screen)
   ========================================================================== */

function ModernPlayer({ track, onEnded, onError, containerRef, volume = 75, onProgress }) {
  const rootRef = useRef(null);
  const playerRef = useRef(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const volumeRef = useRef(volume);
  const onProgressRef = useRef(onProgress);

  onEndedRef.current = onEnded;
  onErrorRef.current = onError;
  volumeRef.current = volume;
  onProgressRef.current = onProgress;

  useEffect(() => {
    let cancelled = false;
    let ended = false;
    let progressTimer = null;
    setAutoplayBlocked(false);
    setIsPlaying(false);

    if (!track?.videoId) return undefined;

    const create = () => {
      if (cancelled || !rootRef.current) return;
      const mount = document.createElement("div");
      rootRef.current.appendChild(mount);

      playerRef.current = new window.YT.Player(mount, {
        videoId: track.videoId,
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin
        },
        events: {
          onReady: ({ target }) => {
            target.setVolume(volumeRef.current);
            target.playVideo();
          },
          onStateChange: ({ data, target }) => {
            if (cancelled || ended) return;
            const playing = data === window.YT.PlayerState.PLAYING;
            setIsPlaying(playing);

            if (playing) {
              setAutoplayBlocked(false);
              clearInterval(progressTimer);
              progressTimer = setInterval(() => {
                try {
                  const current = target.getCurrentTime?.() || 0;
                  const dur = target.getDuration?.() || 0;
                  onProgressRef.current?.({ time: current, duration: dur });
                } catch {
                  // ignore
                }
              }, 1000);
            } else {
              clearInterval(progressTimer);
            }

            if (data === window.YT.PlayerState.ENDED) {
              ended = true;
              clearInterval(progressTimer);
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
      clearInterval(progressTimer);
      try {
        playerRef.current?.destroy?.();
      } catch {}
      playerRef.current = null;
      if (rootRef.current) rootRef.current.textContent = "";
    };
  }, [track?.videoId]);

  const unlockAudio = () => {
    const player = playerRef.current;
    if (!player) return;
    player.unMute?.();
    player.setVolume?.(volumeRef.current);
    player.playVideo?.();
    setAutoplayBlocked(false);
  };

  return (
    <div className="m-video-stage" ref={containerRef}>
      <div className="m-video-stage-mount" ref={rootRef} aria-label={track ? `YouTube ${track.title}` : undefined} />

      {!track && (
        <div className="m-stage-empty">
          <div className="m-stage-empty-icon">
            <Mic2 size={42} />
          </div>
          <h2>เวทีคาราโอเกะพร้อมแล้ว</h2>
          <p>สแกน QR Code ด้านขวาด้วยมือถือ เพื่อค้นหาและเริ่มต่อคิวเพลงโปรดของคุณ</p>
        </div>
      )}

      {track && autoplayBlocked && (
        <div className="m-autoplay-banner" onClick={unlockAudio}>
          <VolumeX size={26} className="text-pink" />
          <div>
            <strong>คลิกที่นี่เพื่อเปิดเสียง</strong>
            <div style={{ fontSize: "0.82rem", opacity: 0.8 }}>เบราว์เซอร์ระงับเสียงอัตโนมัติไว้</div>
          </div>
        </div>
      )}
    </div>
  );
}

function LyricsDrawer({ track, open, onClose, notify }) {
  const [lyrics, setLyrics] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    if (!track?.videoId || !open) {
      setLyrics("");
      return undefined;
    }
    setLoading(true);
    karaokeApi.lyrics(track.videoId)
      .then((data) => {
        if (!live) return;
        const item = data.item || null;
        setLyrics(item?.content || "");
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => { live = false; };
  }, [track?.videoId, open]);

  const searchLRCLIB = async () => {
    if (!track) return;
    setLoading(true);
    try {
      const data = await karaokeApi.searchLyrics(track.title, track.channelTitle);
      const first = data.results?.[0];
      if (!first?.content) throw new Error("ไม่พบเนื้อร้องจาก LRCLIB");
      setLyrics(first.content);
      notify("ดึงเนื้อร้องจาก LRCLIB สำเร็จ");
    } catch (err) {
      notify(err.message || "ค้นหาเนื้อร้องไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  const googleLyricsUrl = track
    ? `https://www.google.com/search?q=${encodeURIComponent(`${track.title || ""} ${track.channelTitle || ""} lyrics`)}`
    : "#";

  return (
    <aside className="m-lyrics-drawer" aria-label="เนื้อร้อง">
      <header className="m-lyrics-header">
        <div>
          <span className="m-badge m-badge-karaoke">เนื้อร้อง</span>
          <h4 style={{ margin: "0.25rem 0 0", fontSize: "0.95rem", color: "#fff", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {track?.title || "กำลังเล่น"}
          </h4>
        </div>
        <button className="m-btn-icon" onClick={onClose} aria-label="ปิดเนื้อร้อง">
          <X size={16} />
        </button>
      </header>

      <div className="m-lyrics-body">
        {loading ? (
          <div style={{ textAlign: "center", padding: "2rem", color: "var(--m-text-muted)" }}>
            <LoaderCircle className="spin" size={28} style={{ margin: "0 auto 0.75rem" }} />
            <p>กำลังค้นหาเนื้อร้อง…</p>
          </div>
        ) : lyrics ? (
          <pre>{lyrics}</pre>
        ) : (
          <div style={{ textAlign: "center", padding: "1.5rem", color: "var(--m-text-muted)" }}>
            <Music2 size={32} style={{ margin: "0 auto 0.5rem", opacity: 0.6 }} />
            <p style={{ fontSize: "0.9rem", margin: "0 0 1.25rem" }}>
              ยังไม่พบเนื้อร้องแบบข้อความ<br />
              (คลิปคาราโอเกะส่วนใหญ่มีเนื้อร้องในวิดีโออยู่แล้ว)
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <button className="m-btn m-btn-primary" onClick={searchLRCLIB}>
                <Sparkles size={16} /> ค้นหาจาก LRCLIB
              </button>
              <a className="m-btn m-btn-secondary" href={googleLyricsUrl} target="_blank" rel="noreferrer">
                ค้นหาใน Google <ExternalLink size={14} />
              </a>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

export function ModernDisplayView() {
  const [session, setSession] = useState(() => readSession(HOST_STORAGE_KEY));
  const [room, setRoom] = useState(emptyRoomState);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [playbackTime, setPlaybackTime] = useState({ time: 0, duration: 0 });

  const toastTimer = useRef();
  const videoContainerRef = useRef(null);

  const notify = useCallback((text) => {
    setMessage(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(""), 5000);
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
      notify("เปิดห้องคาราโอเกะใหม่เรียบร้อย 🎉");
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

  const reportFailure = useCallback(async (code) => {
    if (!session) return;
    notify("วิดีโอนี้เล่นไม่ได้ กำลังข้ามไปยังเพลงถัดไป…");
    const reason = {
      2: "player_error",
      5: "player_error",
      100: "private",
      101: "embed_disabled",
      150: "embed_disabled"
    }[code] || "network";
    try {
      await hostedApi.currentFailure(session.roomId, session.token, reason, `YouTube error ${code}`);
    } catch {}
  }, [session, notify]);

  const copyJoinLink = () => {
    if (!session) return;
    const joinUrl = joinUrlFor(session.joinPath);
    const copy = navigator.clipboard?.writeText?.(joinUrl);
    if (!copy?.then) {
      notify("เบราว์เซอร์นี้ไม่รองรับการคัดลอกลิงก์");
      return;
    }
    copy.then(() => {
      setCopied(true);
      notify("คัดลอกลิงก์เข้าร่วมห้องแล้ว");
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => notify("คัดลอกลิงก์ไม่สำเร็จ"));
  };

  const joinUrl = session
    ? `${window.location.origin}${session.joinPath}${window.location.search.includes("ui=modern") ? "&ui=modern" : ""}`
    : "";

  if (!session) {
    return (
      <div className="modern-root m-display-container" style={{ display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", padding: "2rem", maxWidth: "480px" }}>
          <div className="m-stage-empty-icon" style={{ margin: "0 auto 1.5rem" }}>
            <LoaderCircle className="spin" size={38} />
          </div>
          <h2 style={{ fontSize: "1.6rem", fontWeight: "800", color: "#fff", marginBottom: "0.5rem" }}>
            {error ? "เปิดห้องไม่สำเร็จ" : "กำลังเปิดห้องคาราโอเกะ…"}
          </h2>
          <p style={{ color: "var(--m-text-muted)", fontSize: "0.95rem", lineHeight: "1.6" }}>
            {error || "ระบบกำลังสร้าง QR Code และเชื่อมต่อสถานีคาราโอเกะ กรุณารอสักครู่"}
          </p>
          {error && (
            <button className="m-btn m-btn-primary" style={{ marginTop: "1rem" }} onClick={createRoom}>
              <RotateCcw size={16} /> ลองใหม่อีกครั้ง
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="modern-root m-display-container">
      {/* Video Stage with Ambient Vignette */}
      <ModernPlayer
        track={room.current}
        onEnded={advance}
        onError={reportFailure}
        containerRef={videoContainerRef}
        onProgress={setPlaybackTime}
      />
      <div className="m-stage-vignette" />

      {/* Top Floating Smart HUD */}
      <header className="m-top-hud" aria-label="สถานะจอคาราโอเกะ">
        <div className="m-hud-brand">
          <div className="m-hud-brand-icon">
            <Mic2 size={20} />
          </div>
          <span>KaraokeStation</span>
        </div>

        {room.current && (
          <div className="m-hud-track-info">
            <Equalizer />
            <div className="m-hud-track-meta">
              <div className="m-hud-track-status">
                <span>กำลังเล่น</span>
                <span style={{ color: "var(--m-text-dim)" }}>•</span>
                <span>{timecode(playbackTime.time)} / {timecode(playbackTime.duration)}</span>
              </div>
              <h1 className="m-hud-track-title">{room.current.title}</h1>
              <p className="m-hud-track-artist">{room.current.channelTitle || "YouTube"}</p>
            </div>
          </div>
        )}

        <div className="m-hud-actions">
          {session && (
            <div className="m-room-code-badge" title="คลิกเพื่อคัดลอกลิงก์" onClick={copyJoinLink} style={{ cursor: "pointer" }}>
              <Radio size={14} className="text-cyan" />
              <span>ห้อง <strong>{session.roomId}</strong></span>
              {copied ? <Check size={14} /> : <Copy size={13} style={{ opacity: 0.6 }} />}
            </div>
          )}

          <div className="m-badge-status">
            <span className={`m-beacon ${connected ? "online" : "offline"}`} />
            <span>{connected ? "Online" : "Connecting"}</span>
          </div>

          <button
            className={`m-btn-icon ${lyricsOpen ? "accent" : ""}`}
            onClick={() => setLyricsOpen((v) => !v)}
            aria-label="เปิด/ปิดเนื้อร้อง"
            title="เนื้อร้อง"
          >
            <Mic size={18} />
          </button>

          <button
            className="m-btn-icon"
            onClick={toggleFullscreen}
            aria-label="ขยายเต็มจอ"
            title="เต็มหน้าจอ"
          >
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        </div>
      </header>

      {/* Floating QR Card on Right */}
      {session && (
        <aside className="m-side-card" aria-label="กล่อง QR Code สำหรับเข้าร่วม">
          <div className="m-side-card-kicker">
            <Sparkles size={14} className="text-cyan" />
            <span>เพิ่มเพลงจากมือถือ</span>
          </div>

          <div className="m-qr-frame">
            <QRCodeSVG value={joinUrl} size={140} bgColor="#ffffff" fgColor="#0c101d" />
          </div>

          <div className="m-qr-steps">
            <strong>1. สแกน QR</strong> ➔ <strong>2. ตั้งชื่อ</strong><br />
            <strong>3. เลือกเพลงโปรดได้ทันที</strong>
          </div>

          <button className="m-btn m-btn-secondary" style={{ width: "100%", fontSize: "0.78rem" }} onClick={createRoom}>
            <RotateCcw size={14} /> สร้างห้องใหม่
          </button>
        </aside>
      )}

      {/* Floating Next-Up Pill */}
      {room.queue[0] && (
        <div className="m-next-up-pill">
          <img src={room.queue[0].thumbnailUrl || `https://i.ytimg.com/vi/${room.queue[0].videoId}/mqdefault.jpg`} alt="" className="m-next-up-thumb" />
          <div className="m-next-up-text">
            <div className="m-next-up-label">
              <span>คิวถัดไป</span> {room.queue[0].requestedBy && `• ขอโดย ${room.queue[0].requestedBy}`}
            </div>
            <div className="m-next-up-title">{room.queue[0].title}</div>
          </div>
        </div>
      )}

      {/* Lyrics Drawer */}
      <LyricsDrawer
        track={room.current}
        open={lyricsOpen}
        onClose={() => setLyricsOpen(false)}
        notify={notify}
      />

      <Toast message={message} onClose={() => setMessage("")} />
    </div>
  );
}

/* ==========================================================================
   2. Mobile Controller / Party View
   ========================================================================== */

function JoinForm({ roomId, onJoin }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError("");
    try {
      await onJoin(name.trim());
    } catch (joinError) {
      setError(joinError.message || "เข้าร่วมห้องไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modern-root m-join-container">
      <div className="m-join-card">
        <div className="m-join-icon">
          <Mic2 size={38} />
        </div>
        <h1>KaraokeStation</h1>
        <p>{roomId ? `ยินดีต้อนรับสู่ห้อง ${roomId} — ใส่ชื่อเล่นเพื่อเริ่มเลือกเพลง` : "สแกน QR Code จากหน้าจอทีวีเพื่อเข้าร่วมห้อง"}</p>

        {roomId ? (
          <form onSubmit={submit}>
            <div className="m-join-input-group">
              <label htmlFor="singer-name">ชื่อของคุณ</label>
              <input
                id="singer-name"
                className="m-join-input"
                maxLength={20}
                placeholder="เช่น นัท, แจน, บอส..."
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            {error && <p style={{ color: "var(--m-danger)", fontSize: "0.85rem", marginBottom: "1rem" }}>{error}</p>}
            <button className="m-btn m-btn-primary" style={{ width: "100%", height: "3.25rem" }} disabled={loading || !name.trim()}>
              {loading ? <LoaderCircle className="spin" size={18} /> : "เริ่มร้องเพลงกันเลย 🎤"}
            </button>
          </form>
        ) : (
          <div style={{ padding: "1.5rem", background: "rgba(0,0,0,0.2)", borderRadius: "var(--m-radius-md)" }}>
            <p style={{ margin: 0, fontSize: "0.88rem" }}>กรุณาสแกน QR Code จากหน้าจอทีวีหลักเพื่อเปิดห้องนี้</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ModernResultCard({ track, onAdd, onPlayNow }) {
  const badgeClass = track.classification === "instrumental"
    ? "m-badge-instrumental"
    : track.classification === "backing_track"
    ? "m-badge-backing"
    : "m-badge-karaoke";

  return (
    <div className="m-song-card">
      <img
        src={track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`}
        alt=""
        className="m-song-card-thumb"
      />
      <div className="m-song-card-meta">
        <span className={`m-badge ${badgeClass}`}>{track.badge || "Karaoke"}</span>
        <h4 className="m-song-card-title">{track.title}</h4>
        <p className="m-song-card-channel">{track.channelTitle || "YouTube"}</p>
      </div>
      <div className="m-song-card-actions">
        <button
          className="m-btn-icon"
          style={{ width: "2.25rem", height: "2.25rem" }}
          onClick={() => onPlayNow(track)}
          title="เล่นทันที"
          aria-label={`เล่น ${track.title} ทันที`}
        >
          <Play size={16} />
        </button>
        <button
          className="m-btn-icon accent"
          style={{ width: "2.25rem", height: "2.25rem" }}
          onClick={() => onAdd(track)}
          title="เพิ่มเข้าคิว"
          aria-label={`เพิ่ม ${track.title} เข้าคิว`}
        >
          <Plus size={18} />
        </button>
      </div>
    </div>
  );
}

export function ModernControllerView({ session, onRevoked }) {
  const [tab, setTab] = useState("search");
  const [room, setRoom] = useState(emptyRoomState);
  const [connected, setConnected] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [notice, setNotice] = useState("");
  const [reorderMode, setReorderMode] = useState(false);
  const [movingQueueId, setMovingQueueId] = useState("");
  const [confirmModal, setConfirmModal] = useState(null);
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

  // Live suggestions when typing
  useEffect(() => {
    let active = true;
    if (query.trim().length < 2) {
      setSuggestions([]);
      return undefined;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await karaokeApi.suggestions(query, session.token);
        if (active) setSuggestions(data.items || data.suggestions || []);
      } catch {
        if (active) setSuggestions([]);
      }
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, session.token]);

  const guard = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      if (isSessionRevokedError(`${error.code} ${error.status}`)) onRevoked();
      throw error;
    }
  };

  const doSearch = async (searchTerm) => {
    const term = searchTerm || query;
    if (!term.trim()) return;
    setPhase("loading");
    setSuggestions([]);

    const isDirectLink = /youtube\.com|youtu\.be|^[A-Za-z0-9_-]{11}$/i.test(term.trim());
    if (isDirectLink) {
      try {
        const resolved = await guard(() => hostedApi.resolveYouTube(session.roomId, session.token, term.trim()));
        setResults([normalizeTrack(resolved)]);
        setPhase("done");
        return;
      } catch {
        // Fall through to normal search so a pasted title still gets results.
      }
    }
    try {
      const data = await guard(() => hostedApi.search(session.roomId, session.token, term));
      setResults((data.results || []).map(normalizeTrack));
      setPhase("done");
    } catch (error) {
      setNotice(error.message || "ค้นหาเพลงไม่สำเร็จ");
      setPhase("error");
    }
  };

  const add = async (track) => {
    try {
      await guard(() => hostedApi.addTrack(session.roomId, session.token, track));
      setNotice(`เพิ่ม “${track.title}” เข้าคิวแล้ว 🎉`);
    } catch (error) {
      setNotice(error.message || "เพิ่มเพลงไม่สำเร็จ");
    }
  };

  const playNow = async (track) => {
    try {
      if (track.queueId) {
        await guard(() => hostedApi.playNow(session.roomId, session.token, track.queueId, room.revision));
      } else {
        const added = await guard(() => hostedApi.addTrack(session.roomId, session.token, track, { playNow: true }));
        if (added?.item?.id) {
          await guard(() => hostedApi.playNow(session.roomId, session.token, added.item.id, added.revision));
        }
      }
      setNotice(`กำลังเล่น “${track.title}” ทันที 🎤`);
    } catch (error) {
      setNotice(error.message || "ไม่สามารถเล่นเพลงได้");
    } finally {
      setConfirmModal(null);
    }
  };

  const remove = async (track) => {
    try {
      await guard(() => hostedApi.removeTrack(session.roomId, session.token, track.queueId, room.revision));
      setNotice(`ลบ “${track.title}” ออกจากคิวแล้ว`);
    } catch (error) {
      setNotice(error.message || "คิวถูกเปลี่ยนโดยคนอื่น ลองใหม่อีกครั้ง");
    } finally {
      setConfirmModal(null);
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
      setNotice(`ย้าย “${track.title}” ไปลำดับที่ ${toIndex + 1} แล้ว`);
    } catch (error) {
      setNotice(error.message || "คิวถูกเปลี่ยนโดยคนอื่น ลองใหม่อีกครั้ง");
    } finally {
      setMovingQueueId("");
    }
  };

  const skip = async () => {
    try {
      await guard(() => hostedApi.skip(session.roomId, session.token, room.revision));
      setNotice("ข้ามเพลงปัจจุบันแล้ว ⏭️");
    } catch (error) {
      setNotice(error.message || "ข้ามเพลงไม่สำเร็จ");
    } finally {
      setConfirmModal(null);
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

  return (
    <div className="modern-root m-mobile-container">
      {/* Sticky Mobile Header */}
      <header className="m-mobile-header">
        <div className="m-mobile-header-brand">
          <Mic2 size={20} className="text-cyan" />
          <span>ห้อง <strong>{session.roomId}</strong></span>
        </div>
        <div className="m-badge-status">
          <span className={`m-beacon ${connected ? "online" : "offline"}`} />
          <span>{connected ? "เชื่อมต่อแล้ว" : "ขาดการเชื่อมต่อ"}</span>
        </div>
      </header>

      {/* Hero Now Playing Card */}
      <div className="m-mobile-now-playing">
        <div className="m-now-playing-disc">
          {room.current ? <Equalizer /> : <Music2 size={20} />}
        </div>
        <div className="m-now-playing-meta">
          <div className="m-now-playing-kicker">
            <Radio size={12} />
            <span>กำลังเล่นบนทีวี</span>
          </div>
          <div className="m-now-playing-title">{room.current?.title || "ยังไม่มีเพลงกำลังเล่น"}</div>
        </div>
        <button
          className="m-btn m-btn-secondary"
          style={{ padding: "0.45rem 0.85rem", fontSize: "0.8rem", flexShrink: 0 }}
          disabled={!room.current}
          onClick={() => setConfirmModal({
            title: "ข้ามเพลงนี้?",
            detail: `“${room.current?.title}” จะหยุดและเริ่มเพลงถัดไป`,
            action: skip
          })}
        >
          <SkipForward size={14} /> ข้าม
        </button>
      </div>

      <div className="m-mobile-controls">
        <button
          className={`m-btn m-btn-secondary m-fair-toggle${room.settings?.fairQueue ? " active" : ""}`}
          aria-pressed={Boolean(room.settings?.fairQueue)}
          onClick={toggleFairQueue}
          disabled={fairQueueSaving}
        >
          <ArrowUpDown size={16} />
          {room.settings?.fairQueue ? "คิวผลัดกันร้อง: เปิด" : "เปิดคิวผลัดกันร้อง"}
        </button>
      </div>

      {/* Tab Segmented Control */}
      <nav className="m-segment-nav" aria-label="แท็บค้นหาและคิว">
        <button
          className={`m-segment-btn ${tab === "search" ? "active" : ""}`}
          onClick={() => setTab("search")}
        >
          <Search size={16} />
          <span>ค้นหาเพลง</span>
        </button>
        <button
          className={`m-segment-btn ${tab === "queue" ? "active" : ""}`}
          onClick={() => setTab("queue")}
        >
          <ListMusic size={16} />
          <span>คิวเพลง</span>
          {room.queue.length > 0 && (
            <span className="m-tab-badge">{room.queue.length}</span>
          )}
        </button>
      </nav>

      {/* Tab 1: Search View */}
      {tab === "search" && (
        <main>
          <form className="m-search-form" onSubmit={(e) => { e.preventDefault(); doSearch(); }}>
            <Search size={18} className="m-search-icon" />
            <input
              className="m-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหาชื่อเพลง ศิลปิน หรือคาราโอเกะ..."
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                className="m-btn-icon"
                style={{ position: "absolute", right: "4.5rem", width: "2rem", height: "2rem" }}
                onClick={() => { setQuery(""); setSuggestions([]); }}
              >
                <X size={14} />
              </button>
            )}
            <button type="submit" className="m-btn m-btn-primary m-search-submit">
              ค้นหา
            </button>
          </form>

          {/* Quick Genre Chips */}
          <div className="m-genre-chips">
            {GENRE_CHIPS.map((chip) => (
              <button
                key={chip.label}
                className="m-genre-chip"
                onClick={() => {
                  setQuery(chip.query);
                  doSearch(chip.query);
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {/* Auto Suggestions */}
          {suggestions.length > 0 && phase !== "loading" && (
            <div style={{ margin: "0 1rem 0.75rem", display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
              {suggestions.slice(0, 6).map((item) => {
                const text = item.query || item;
                return (
                  <button
                    key={text}
                    className="m-genre-chip"
                    style={{ background: "rgba(255,255,255,0.08)", borderColor: "var(--m-border-glass)" }}
                    onClick={() => { setQuery(text); doSearch(text); }}
                  >
                    🔍 {text}
                  </button>
                );
              })}
            </div>
          )}

          {/* Results List */}
          <div className="m-result-list" aria-live="polite">
            {phase === "idle" && (
              <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--m-text-muted)" }}>
                <Music size={36} style={{ margin: "0 auto 0.75rem", opacity: 0.5 }} />
                <h4>อยากร้องเพลงอะไรดี?</h4>
                <p style={{ fontSize: "0.85rem", margin: "0.25rem 0 0" }}>พิมพ์ชื่อเพลงหรือกดเลือกจากหมวดหมู่ด้านบนได้เลย</p>
              </div>
            )}

            {phase === "loading" && (
              <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--m-text-muted)" }}>
                <LoaderCircle className="spin" size={32} style={{ margin: "0 auto 0.75rem" }} />
                <p>กำลังค้นหาคาราโอเกะคุณภาพสูง…</p>
              </div>
            )}

            {phase === "done" && results.length === 0 && (
              <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--m-text-muted)" }}>
                <Music2 size={36} style={{ margin: "0 auto 0.75rem", opacity: 0.5 }} />
                <h4>ไม่พบคาราโอเกะหรือเพลงประกอบ</h4>
                <p style={{ fontSize: "0.85rem", margin: "0.25rem 0 0" }}>ลองพิมพ์คำค้นอื่น เช่น ใส่ชื่อศิลปินเพิ่ม</p>
              </div>
            )}

            {results.map((track) => (
              <ModernResultCard
                key={track.videoId}
                track={track}
                onAdd={add}
                onPlayNow={(t) => setConfirmModal({
                  title: "ร้องเพลงนี้ทันที?",
                  detail: `“${t.title}” จะเริ่มเล่นบนทีวีทันที`,
                  action: () => playNow(t)
                })}
              />
            ))}
          </div>
        </main>
      )}

      {/* Tab 2: Queue View */}
      {tab === "queue" && (
        <main>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.5rem 1rem" }}>
            <h3 style={{ fontSize: "1.1rem", margin: 0, color: "#fff" }}>
              คิวเพลงรอร้อง <span style={{ color: "var(--m-accent-cyan)" }}>({room.queue.length})</span>
            </h3>
            {room.queue.length > 1 && (
              <button
                className={`m-btn ${reorderMode ? "m-btn-primary" : "m-btn-secondary"}`}
                style={{ padding: "0.4rem 0.85rem", fontSize: "0.8rem" }}
                onClick={() => setReorderMode((v) => !v)}
              >
                <ArrowUpDown size={14} /> {reorderMode ? "เสร็จสิ้น" : "สลับลำดับคิว"}
              </button>
            )}
          </div>

          <div className="m-queue-list">
            {room.queue.length === 0 ? (
              <div style={{ textAlign: "center", padding: "3.5rem 1rem", color: "var(--m-text-muted)" }}>
                <ListMusic size={40} style={{ margin: "0 auto 0.75rem", opacity: 0.5 }} />
                <h4>ยังไม่มีเพลงในคิว</h4>
                <p style={{ fontSize: "0.85rem", margin: "0.25rem 0 1.25rem" }}>เป็นคนแรกที่เปิดเวทีด้วยเพลงโปรดของคุณ!</p>
                <button className="m-btn m-btn-primary" onClick={() => setTab("search")}>
                  <Search size={16} /> ไปค้นหาเพลง
                </button>
              </div>
            ) : (
              room.queue.map((track, index) => (
                <div key={track.queueId} className="m-queue-item">
                  <div className="m-queue-index">#{index + 1}</div>
                  <img
                    src={track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`}
                    alt=""
                    className="m-queue-thumb"
                  />
                  <div className="m-queue-meta">
                    <h4 className="m-queue-title">{track.title}</h4>
                    <div className="m-queue-requester">
                      <User size={12} />
                      <span>{track.requestedBy || track.channelTitle || "เพื่อนร่วมร้อง"}</span>
                    </div>
                  </div>

                  <div className="m-queue-actions">
                    {reorderMode ? (
                      <>
                        <button
                          className="m-btn-icon"
                          style={{ width: "2rem", height: "2rem" }}
                          disabled={index === 0 || Boolean(movingQueueId)}
                          onClick={() => moveQueueItem(track, index, -1)}
                          aria-label="ย้ายขึ้น"
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          className="m-btn-icon"
                          style={{ width: "2rem", height: "2rem" }}
                          disabled={index === room.queue.length - 1 || Boolean(movingQueueId)}
                          onClick={() => moveQueueItem(track, index, 1)}
                          aria-label="ย้ายลง"
                        >
                          <ArrowDown size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="m-btn-icon"
                          style={{ width: "2.25rem", height: "2.25rem" }}
                          onClick={() => setConfirmModal({
                            title: "เล่นเพลงนี้ทันที?",
                            detail: `“${track.title}” จะเริ่มเล่นทันที`,
                            action: () => playNow(track)
                          })}
                          title="เล่นทันที"
                        >
                          <Play size={15} />
                        </button>
                        <button
                          className="m-btn-icon"
                          style={{ width: "2.25rem", height: "2.25rem" }}
                          onClick={() => setConfirmModal({
                            title: "ลบเพลงนี้ออกจากคิว?",
                            detail: `“${track.title}” จะถูกนำออกจากรายการรอ`,
                            action: () => remove(track),
                            danger: true
                          })}
                          title="ลบเพลง"
                        >
                          <Trash2 size={15} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </main>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          detail={confirmModal.detail}
          danger={confirmModal.danger}
          onConfirm={confirmModal.action}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      <Toast message={notice} onClose={() => setNotice("")} />
    </div>
  );
}

export function ModernPartyView() {
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
  return <ModernControllerView session={session} onRevoked={revoked} />;
}

/* ==========================================================================
   Root Export
   ========================================================================== */

export default function ModernApp() {
  const isParty = window.location.pathname === "/party" || window.location.pathname.startsWith("/remote");
  return isParty ? <ModernPartyView /> : <ModernDisplayView />;
}

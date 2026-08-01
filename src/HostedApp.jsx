import { useCallback, useEffect, useRef, useState } from "react";
import { ListMusic, LoaderCircle, Maximize2, Mic2, Minimize2, Music2, Play, Plus, Search, SkipForward, Trash2, Volume2, Wifi, WifiOff, X } from "lucide-react";
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
} from "./lib/hosted-api";
import { loadYouTubeIframeApi } from "./lib/youtube";
import "./hosted.css";

const emptyRoomState = { revision: 0, current: null, queue: [], stationName: "KaraokeStation" };

function viewToState(view) {
  const queue = normalizeQueue({ revision: view.revision, current: view.current, items: view.queue });
  return {
    revision: queue.revision,
    current: queue.current,
    queue: queue.items,
    stationName: view.stationName || "KaraokeStation"
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
  if (!message) return null;
  return (
    <div className="display-toast" role="status">
      <Mic2 size={18} />
      <span>{message}</span>
      <button className="icon-button" aria-label="ปิดข้อความ" onClick={onClose}><X size={16} /></button>
    </div>
  );
}

function HostedPlayer({ track, onEnded, onError, volume = 75 }) {
  const rootRef = useRef(null);
  const playerRef = useRef(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  // Keep the callbacks in refs so the player effect depends only on the video id.
  // Re-running it on every parent render would tear down and rebuild the iframe.
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const volumeRef = useRef(volume);
  onEndedRef.current = onEnded;
  onErrorRef.current = onError;
  volumeRef.current = volume;

  useEffect(() => {
    let cancelled = false;
    // Per-run flag rather than a ref: a ref is shared across effect runs, so a
    // remount would reset it and re-enable an already-spent ENDED handler.
    let ended = false;
    setAutoplayBlocked(false);
    if (!track?.videoId) return undefined;

    const create = () => {
      if (cancelled || !rootRef.current) return;
      // The YouTube API REPLACES the element it is given with its own iframe.
      // Handing it a React-rendered node makes React lose track of that node and
      // throw NotFoundError on unmount, which blanks the whole screen. So we mount
      // a plain child that React never manages and let YouTube consume that.
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
            // `cancelled` scopes this guard to THIS effect run. Without it, a player
            // torn down by StrictMode's double-invoke (or a fast track change) could
            // still fire ENDED and advance the queue, silently eating a song.
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
      // Clear whatever YouTube left behind. React never owned these children, so
      // emptying the container here is safe and keeps the next mount clean.
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
    <div className="hosted-video">
      {/* Stable container React owns; YouTube only ever touches its children. */}
      <div className="hosted-video-mount" ref={rootRef} aria-label={track ? `YouTube ${track.title}` : undefined} />
      {!track && <Empty title="รอเพลงแรก" detail="สแกน QR ด้วยมือถือเพื่อค้นหาและเพิ่มเพลง" />}
      {track && autoplayBlocked && (
        <button className="hosted-autoplay-unlock" onClick={resumeWithSound}>
          <Volume2 size={22} />
          <span><strong>แตะเพื่อเปิดเสียง</strong>เบราว์เซอร์หยุดการเล่นอัตโนมัติไว้</span>
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
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const toastTimer = useRef();

  const notify = useCallback((text) => {
    setMessage(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(""), 5_000);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
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

  // A display with no session starts a room automatically, so the TV only ever
  // needs the URL — no buttons, no setup.
  useEffect(() => {
    if (!session && !creating) void createRoom();
  }, [session, creating, createRoom]);

  useEffect(() => {
    if (!session) return undefined;
    let stop = false;
    hostedApi.room(session.roomId, session.token)
      .then((view) => { if (!stop) setRoom(viewToState(view)); })
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
      if (event.type === "room") setRoom(viewToState(event.view));
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
      // A 409 means someone else already advanced; the socket will deliver the truth.
      if (requestError.status !== 409) notify(requestError.message);
    }
  }, [session, room.revision, notify]);

  /**
   * Skipping the current song is destructive, so it only happens for errors that
   * mean the video itself is unplayable — and only after one retry.
   *
   * Without the retry, anything that breaks the player globally (offline, YouTube
   * blocked, iframe API failing to load) would report a failure for every track in
   * turn and silently drain the whole queue.
   */
  const failureCountRef = useRef({ videoId: null, count: 0 });
  const currentVideoIdRef = useRef(null);
  currentVideoIdRef.current = room.current?.videoId ?? null;

  const reportFailure = useCallback(async (code) => {
    if (!session) return;
    const unplayable = {
      2: "player_error",        // invalid video id
      5: "player_error",        // HTML5 player error
      100: "private",           // removed or private
      101: "embed_disabled",    // embedding not allowed
      150: "embed_disabled"     // embedding not allowed (alias)
    };
    const reason = unplayable[code];
    if (!reason) {
      // Loader/network trouble: keep the song, let the user retry.
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
      // The next snapshot will resync the queue.
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
        <HostedPlayer track={room.current} onEnded={advance} onError={reportFailure} />

        <header className="hosted-topbar" aria-label="สถานะจอคาราโอเกะ">
          <div className="hosted-browser-mark" aria-hidden="true">
            <i /><i /><i />
          </div>
          <div className="hosted-topbar-brand">
            <Mic2 size={18} />
            <strong>{room.stationName}</strong>
          </div>
          <div className="hosted-status">
            <span className={connected ? "connected" : "disconnected"}>
              {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
              {connected ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ"}
            </span>
            <strong className="hosted-room-code">ห้อง {session.roomId}</strong>
          </div>
          <button className="hosted-fullscreen-button" onClick={toggleFullscreen} aria-label={isFullscreen ? "ออกจากโหมดเต็มจอ" : "เปิดโหมดเต็มจอ"}>
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        </header>

        <div className="hosted-meta">
          <div className="hosted-meta-text">
            <p>กำลังเล่น</p>
            <h1 title={room.current?.title || room.stationName}>
              {room.current?.title || room.stationName}
            </h1>
            <span>{room.current?.channelTitle || "จอคาราโอเกะพร้อมแล้ว"}</span>
          </div>
        </div>

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
            <input aria-label="ชื่อของคุณ" maxLength="20" value={name} onChange={(event) => setName(event.target.value)} />
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

function ResultRow({ track, onAdd }) {
  return (
    <article className="song-result">
      <img src={track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`} alt="" />
      <div>
        {track.badge && <span className="type-badge">{track.badge}</span>}
        <h3>{track.title}</h3>
        <p>{track.channelTitle || "YouTube"}</p>
      </div>
      <button className="icon-button accent" aria-label={`เพิ่ม ${track.title} เข้าคิว`} onClick={() => onAdd(track)}>
        <Plus size={18} />
      </button>
    </article>
  );
}

function ControllerView({ session, onRevoked }) {
  const [tab, setTab] = useState("search");
  const [room, setRoom] = useState(emptyRoomState);
  const [connected, setConnected] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [notice, setNotice] = useState("");

  useEffect(() => connectRoom(session, (event) => {
    if (event.type === "connection") setConnected(event.connected);
    if (event.type === "room") setRoom(viewToState(event.view));
    if (event.type === "revoked") onRevoked();
  }), [session, onRevoked]);

  useEffect(() => {
    let stop = false;
    hostedApi.queue(session.roomId, session.token)
      .then((view) => { if (!stop) setRoom(viewToState(view)); })
      .catch((error) => {
        if (!stop && isSessionRevokedError(`${error.code} ${error.status}`)) onRevoked();
      });
    return () => { stop = true; };
  }, [session, onRevoked]);

  const guard = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      if (isSessionRevokedError(`${error.code} ${error.status}`)) onRevoked();
      throw error;
    }
  };

  const search = async (event) => {
    event.preventDefault();
    if (!query.trim()) return;
    setPhase("loading");
    try {
      const data = await guard(() => hostedApi.search(session.roomId, session.token, query));
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

  const skip = async () => {
    try {
      await guard(() => hostedApi.skip(session.roomId, session.token, room.revision));
      setNotice("ข้ามเพลงแล้ว");
    } catch (error) {
      setNotice(error.message || "ข้ามเพลงไม่สำเร็จ");
    }
  };

  return (
    <main className="party hosted-party">
      <header className="hosted-party-header">
        <span className="party-brand"><Music2 size={18} /> ห้อง {session.roomId}</span>
        <span className={connected ? "connected" : "disconnected"}>
          {connected ? <Wifi size={15} /> : <WifiOff size={15} />} {connected ? "เชื่อมต่อ" : "ขาดการเชื่อมต่อ"}
        </span>
      </header>

      <section className="now-playing">
        <span>กำลังเล่นบนทีวี</span>
        <strong>{room.current?.title || "ยังไม่มีเพลง"}</strong>
        <button className="skip-link" onClick={skip} disabled={!room.current}>
          <SkipForward size={16} /> Skip
        </button>
      </section>

      {tab === "search" ? (
        <section className="mobile-section">
          <h1>ค้นหาเพลง</h1>
          <p>แสดงเฉพาะ Karaoke, Instrumental และ Backing Track</p>
          <form onSubmit={search} className="mobile-search">
            <Search size={20} />
            <input
              aria-label="ค้นหาเพลง"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ชื่อเพลงหรือศิลปิน"
              autoComplete="off"
            />
            <button className="button primary" type="submit">ค้นหา</button>
          </form>
          <div className="results" aria-live="polite">
            {phase === "idle" && <Empty title="อยากร้องเพลงอะไรดี?" detail="พิมพ์ชื่อเพลงแล้วกดค้นหา" />}
            {phase === "loading" && <p className="loading"><LoaderCircle className="spin" /> กำลังค้นหา…</p>}
            {phase === "done" && results.length === 0 && (
              <Empty title="ไม่พบคาราโอเกะหรือเพลงประกอบ" detail="ลองเปลี่ยนคำค้นอีกนิด" />
            )}
            {results.map((track) => <ResultRow key={track.videoId} track={track} onAdd={add} />)}
          </div>
        </section>
      ) : (
        <section className="mobile-section queue-tab">
          <h1>คิวเพลง <span>({room.queue.length})</span></h1>
          <p>ทุกคนลบ ข้าม หรือเล่นทันทีได้</p>
          {room.queue.length ? (
            <ol>
              {room.queue.map((track, index) => (
                <li key={track.queueId}>
                  <span>{index + 1}</span>
                  <img src={track.thumbnailUrl} alt="" />
                  <div>
                    <strong>{track.title}</strong>
                    <small>{track.requestedBy || track.channelTitle}</small>
                  </div>
                  <div className="queue-row-actions">
                    <button className="icon-button" aria-label={`เล่น ${track.title} ทันที`} onClick={() => playNow(track)}>
                      <Play size={17} />
                    </button>
                    <button className="icon-button" aria-label={`ลบ ${track.title}`} onClick={() => remove(track)}>
                      <Trash2 size={17} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <Empty title="คิวว่าง" detail="ไปที่แท็บค้นหาเพื่อเพิ่มเพลงต่อไป" />
          )}
        </section>
      )}

      <nav className="bottom-tabs" aria-label="เมนูมือถือ">
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
          <Search /> ค้นหา
        </button>
        <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
          <ListMusic /> คิว {room.queue.length}
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

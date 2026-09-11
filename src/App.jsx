import { forwardRef, useEffect, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowUpDown, ChevronDown, ChevronUp, ExternalLink, GripVertical, ListMusic, LoaderCircle, Maximize, Menu, Mic2, Music2, Pause, Play, Plus, QrCode, Search, Settings, SkipForward, Trash2, Volume2, Wifi, WifiOff, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { connectStation, karaokeApi, normalizeQueue, normalizeTrack } from "./lib/api";
import { loadYouTubeIframeApi } from "./lib/youtube";

const emptyPlayer = { track: null, playing: false, time: 0, duration: 0, volume: 75 };
const positiveKinds = ["karaoke", "instrumental", "backing", "backing_track", "คาราโอเกะ"];
export const partySearchMode = "both";
const focusable = "a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
const timecode = (seconds) => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "--:--";
const labels = { karaoke: "Karaoke", instrumental: "Instrumental", backing: "Backing Track", "คาราโอเกะ": "คาราโอเกะ" };

export function isKaraokeResult(track) {
  const candidate = `${track?.classification || ""} ${track?.kind || ""} ${track?.title || ""} ${track?.description || ""}`.toLowerCase();
  return positiveKinds.some((kind) => candidate.includes(kind));
}
export function karaokeBadge(track) {
  const candidate = `${track?.classification || ""} ${track?.kind || ""} ${track?.title || ""}`.toLowerCase();
  return positiveKinds.find((kind) => candidate.includes(kind)) || "karaoke";
}
export function isInstrumental(track) { return karaokeBadge(track) === "instrumental" || karaokeBadge(track) === "backing"; }
export function googleLyricsUrl(track) { return `https://www.google.com/search?q=${encodeURIComponent(`${track?.title || ""} ${track?.channelTitle || ""} lyrics`)}`; }
export function consumeLaunchToken() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = params.get("join");
  if (token) history.replaceState(null, "", `${location.pathname}${location.search}`);
  return token;
}
// Kept as small pure helpers for state-level regression tests and player behavior.
export function resolveLyricsMode(currentMode, settings, syncDefault = false) { return syncDefault ? (settings?.defaultLyricsMode === "fullscreen" ? "full" : settings?.defaultLyricsMode || currentMode) : currentMode; }
export function playbackIntentForMutation(currentTrack, { playNow = false, advance = false } = {}) { return Boolean(currentTrack && (playNow || advance)); }
export function playbackStateAfterAdd(previousPlaying, currentTrack, playNow) { return playNow ? playbackIntentForMutation(currentTrack, { playNow }) : previousPlaying; }
export function playbackStateAfterCurrentUpdate(previousPlaying, currentTrack, { continuePlayback = false } = {}) { return currentTrack ? (continuePlayback || previousPlaying) : false; }
export function youtubePlayerVars(shouldAutoplay, origin = location.origin) {
  return {
    autoplay: shouldAutoplay ? 1 : 0,
    controls: 0,
    disablekb: 1,
    fs: 0,
    playsinline: 1,
    rel: 0,
    cc_load_policy: 0,
    iv_load_policy: 3,
    origin
  };
}
export function handleAutoplayBlocked(callback) { callback?.(); }
export function isInvalidPartySessionError(error) { return /401|unauthor|token|party_auth_required|party_session_expired|io server disconnect|server disconnect/i.test(error || ""); }
export function shouldConfirmPlayNow(currentTrack, confirmPlayNow) { return Boolean(currentTrack && confirmPlayNow); }
export function isEnabledSingleKeyShortcut(key, enabled) { return Boolean(enabled && ["/", "q", "l"].includes(String(key).toLowerCase())); }
export function needsPlayNowAfterAdd(added) { return Boolean(added?.item && added?.queue?.current?.id !== added.item.id && added?.position !== 0); }

function useDialog(open, onClose, ref, firstRef) {
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const timer = setTimeout(() => (firstRef.current || ref.current?.querySelector(focusable))?.focus(), 0);
    const keydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = [...(ref.current?.querySelectorAll(focusable) || [])];
      if (!items.length) return;
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { clearTimeout(timer); document.removeEventListener("keydown", keydown); if (opener?.isConnected) opener.focus(); };
  }, [open, onClose, ref, firstRef]);
}

const IconButton = forwardRef(function IconButton({ label, children, ...props }, ref) { return <button ref={ref} className="icon-button" aria-label={label} title={label} {...props}>{children}</button>; });
function Toast({ toast, onClose }) { return toast ? <div className="display-toast" role="status"><Mic2 size={18}/><span>{toast}</span><IconButton label="ปิดข้อความ" onClick={onClose}><X size={16}/></IconButton></div> : null; }
function Empty({ title, detail }) { return <div className="empty-state"><Music2 size={34}/><h2>{title}</h2><p>{detail}</p></div>; }

function YouTubePlayer({ player, onPlayer, onEnd, onError }) {
  const rootRef = useRef(null), youtubeRef = useRef(null);
  const track = player.track;
  useEffect(() => {
    let cancelled = false, interval;
    if (!track?.videoId) { youtubeRef.current?.destroy?.(); youtubeRef.current = null; return undefined; }
    const create = () => {
      if (cancelled || !rootRef.current) return;
      youtubeRef.current?.destroy?.();
      youtubeRef.current = new window.YT.Player(rootRef.current, { videoId: track.videoId, playerVars: youtubePlayerVars(player.playing), events: {
        onReady: ({ target }) => { target.unloadModule?.("captions"); target.setVolume(player.volume); if (player.playing) target.playVideo(); },
        onStateChange: ({ data, target }) => {
          const playing = data === window.YT.PlayerState.PLAYING;
          if ([window.YT.PlayerState.PLAYING, window.YT.PlayerState.PAUSED].includes(data)) onPlayer({ playing });
          clearInterval(interval);
          if (playing) interval = setInterval(() => onPlayer({ time: target.getCurrentTime(), duration: target.getDuration() }), 1000);
          if (data === window.YT.PlayerState.ENDED) onEnd();
        },
        onError: ({ data }) => onError(data),
        onAutoplayBlocked: () => onPlayer({ playing: false, autoplayBlocked: true })
      }});
    };
    if (window.YT?.Player) create(); else loadYouTubeIframeApi().then(create).catch(() => onError("loader"));
    return () => { cancelled = true; clearInterval(interval); youtubeRef.current?.destroy?.(); youtubeRef.current = null; };
  }, [track?.videoId]);
  const play = () => youtubeRef.current?.playVideo();
  const pause = () => youtubeRef.current?.pauseVideo();
  return <div className="tv-player">
    <div className="tv-video">{track ? <div ref={rootRef} aria-label={`YouTube ${track.title}`} /> : <Empty title="รอเพลงแรก" detail="สแกน QR ด้วยมือถือเพื่อค้นหาและเพิ่มเพลง" />}</div>
    <div className="tv-track"><div><p>กำลังเล่น</p><h1>{track?.title || "KaraokeStation"}</h1><span>{track?.channelTitle || "จอคาราโอเกะพร้อมแล้ว"} · {timecode(player.time)} / {timecode(player.duration)}</span></div>
      {track && <div className="tv-controls"><IconButton label={player.playing ? "หยุดชั่วคราว" : "เล่น"} onClick={player.playing ? pause : play}>{player.playing ? <Pause/> : <Play/>}</IconButton><label><span className="sr-only">ระดับเสียง</span><Volume2 size={18}/><input type="range" aria-label="ระดับเสียง" min="0" max="100" defaultValue={player.volume} onChange={(e) => youtubeRef.current?.setVolume(+e.target.value)} /></label><IconButton label="เต็มหน้าจอ" onClick={() => document.documentElement.requestFullscreen?.()}><Maximize/></IconButton></div>}</div>
  </div>;
}

function LyricsBento({ track, open, setOpen, settings, notify }) {
  const [lyrics, setLyrics] = useState(null), [text, setText] = useState(""), [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    if (!track?.videoId) { setLyrics(null); setText(""); return undefined; }
    setLoading(true);
    karaokeApi.lyrics(track.videoId).then((data) => {
      if (!live) return;
      const item = data.item || null; setLyrics(item); setText(item?.content || "");
      if (isInstrumental(track) && item?.content) setOpen(true);
    }).catch(() => {}).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [track?.videoId]);
  const lookup = async () => {
    if (!track) return;
    setLoading(true);
    try { const data = await karaokeApi.searchLyrics(track.title, track.channelTitle); const first = data.results?.[0]; if (!first?.content) throw new Error("ไม่พบเนื้อร้อง"); setLyrics(first); setText(first.content); setOpen(true); notify("พบเนื้อร้องจาก LRCLIB แล้ว"); }
    catch (error) { notify(error.message || "ค้นหาเนื้อร้องไม่สำเร็จ"); }
    finally { setLoading(false); }
  };
  if (!open) return <button className="lyrics-tab" onClick={() => setOpen(true)} aria-label="เปิดกล่องเนื้อร้อง"><Mic2 size={18}/>เนื้อร้อง</button>;
  const google = track ? googleLyricsUrl(track) : "#";
  return <aside className="lyrics-bento" aria-label="เนื้อร้อง"><header><div><p>LYRICS</p><h2>{track?.title || "เนื้อร้อง"}</h2></div><IconButton label="ปิดกล่องเนื้อร้อง" onClick={() => setOpen(false)}><X/></IconButton></header><div className="lyrics-body">
    {!track ? <Empty title="ยังไม่มีเพลง" detail="เนื้อร้องจะแสดงที่นี่เมื่อเริ่มเพลง" /> : loading ? <p className="loading"><LoaderCircle className="spin"/> กำลังค้นหาเนื้อร้อง…</p> : text ? <pre>{text}</pre> : <><Empty title="ยังไม่พบเนื้อร้อง" detail="คลิป Karaoke มักมีเนื้อร้องในวิดีโอ ส่วน Instrumental ค้นหาเพิ่มได้"/><div className="lyrics-actions"><button className="button primary" onClick={lookup}>ค้นหา LRCLIB</button><a className="button secondary" href={google} target="_blank" rel="noreferrer">ค้นหา Google <ExternalLink size={16}/></a></div></>}
  </div></aside>;
}

function DisplaySettings({ onClose, party, rotate, connected, settings, onSettings }) {
  const panel = useRef(null), close = useRef(null); const [stationName, setStationName] = useState(settings.stationName || "KaraokeStation"); const [key, setKey] = useState(""); const [saving, setSaving] = useState(false); const [message, setMessage] = useState("");
  useDialog(true, onClose, panel, close);
  const save = async () => { setSaving(true); setMessage(""); try { await onSettings({ stationName }); if (key.trim()) { await karaokeApi.saveYouTubeKey(key); setKey(""); } setMessage("บันทึกแล้ว — API key ไม่ถูกแสดงหรือเก็บในเบราว์เซอร์"); } catch (error) { setMessage(error.message); } finally { setSaving(false); } };
  const clearKey = async () => { setSaving(true); setMessage(""); try { await karaokeApi.saveYouTubeKey(""); setKey(""); setMessage("ลบ YouTube API key ออกจากเครื่องนี้แล้ว"); } catch (error) { setMessage(error.message); } finally { setSaving(false); } };
  return <div className="modal-scrim" onMouseDown={onClose}><section className="modal compact host-settings" ref={panel} role="dialog" aria-modal="true" aria-labelledby="station-settings" onMouseDown={(e) => e.stopPropagation()}><IconButton ref={close} label="ปิดการตั้งค่า" onClick={onClose}><X/></IconButton><Settings size={24}/><h2 id="station-settings">การตั้งค่าสถานี</h2><p>{connected ? "เชื่อมต่อสถานีแล้ว" : "กำลังเชื่อมต่อสถานี…"}</p><label>ชื่อสถานี<input value={stationName} maxLength="60" onChange={(e) => setStationName(e.target.value)}/></label><label>YouTube API key<input aria-label="YouTube API key" type="password" autoComplete="off" value={key} placeholder="วาง key เพื่อตั้งค่าหรือแทนที่" onChange={(e) => setKey(e.target.value)}/></label><small>ระบบบันทึกเฉพาะบนเครื่องนี้ และไม่ส่ง key ไปยังมือถือ</small>{message && <p className="settings-message" role="status">{message}</p>}<button className="button primary" disabled={saving || !stationName.trim()} onClick={save}>{saving ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}</button><button className="button secondary" disabled={saving} onClick={clearKey}>ลบ YouTube API key</button><button className="button secondary" onClick={rotate}>สร้าง QR / session ใหม่</button></section></div>;
}

function QRCorner({ party, onSettings }) {
  const link = party?.urls?.[0] || party?.joinUrl || (party?.joinPath ? `${location.origin}${party.joinPath}` : "");
  return <aside className="qr-corner"><button className="qr-button" aria-label="เปิดการตั้งค่า QR" onClick={onSettings}>{link ? <QRCodeSVG value={link} size={72} bgColor="#f7f8fa" fgColor="#101317"/> : <QrCode size={48}/>}<span>สแกนเพื่อเลือกเพลง</span></button></aside>;
}

function Display({ state, setState }) {
  const [lyricsOpen, setLyricsOpen] = useState(false), [settingsOpen, setSettingsOpen] = useState(false), [toast, setToast] = useState("");
  const toastTimer = useRef();
  const notify = (message) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 5000); };
  const advance = async () => { try { const q = await karaokeApi.advanceQueue(); applyQueue(q, setState, { playing: true }); } catch (error) { notify(error.message); } };
  const error = async () => { try { const q = await karaokeApi.currentFailure("player_error", "YouTube player error"); applyQueue(q, setState, { playing: true }); } catch (e) { notify(e.message); } };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const saveSettings = async (patch) => { const data = await karaokeApi.updateSettings(patch); setState((old) => ({ ...old, settings: data.settings || { ...old.settings, ...patch } })); };
  return <main className={`display ${lyricsOpen ? "lyrics-open" : ""}`}><IconButton label="การตั้งค่าสถานี" className="host-settings-button" onClick={() => setSettingsOpen(true)}><Settings size={18}/></IconButton><div className="display-main"><YouTubePlayer player={state.player} onPlayer={(patch) => setState((old) => ({ ...old, player: { ...old.player, ...patch } }))} onEnd={advance} onError={error}/>{state.queue[0] && <div className="next-track"><span>ถัดไป</span><strong>{state.queue[0].title}</strong></div>}</div><LyricsBento track={state.player.track} open={lyricsOpen} setOpen={setLyricsOpen} settings={state.settings} notify={notify}/><QRCorner party={state.party} onSettings={() => setSettingsOpen(true)}/>{settingsOpen && <DisplaySettings onClose={() => setSettingsOpen(false)} party={state.party} connected={state.connected} rotate={state.rotateParty} settings={state.settings} onSettings={saveSettings}/>}<Toast toast={toast || state.eventMessage} onClose={() => { setToast(""); setState((old) => ({ ...old, eventMessage: "" })); }}/></main>;
}

function ResultRow({ track, onAdd, onPlay }) { const kind = karaokeBadge(track); return <article className="song-result"><img src={track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`} alt=""/><div><span className="type-badge">{labels[kind] || "Backing Track"}</span><h3>{track.title}</h3><p>{track.channelTitle || "YouTube"}</p></div><div><button className="icon-button" aria-label={`เล่น ${track.title} ทันที`} onClick={() => onPlay(track)}><Play size={18}/></button><button className="icon-button accent" aria-label={`เพิ่ม ${track.title} เข้าคิว`} onClick={() => onAdd(track)}><Plus size={18}/></button></div></article>; }

function SearchTab({ token, onMutate, notice }) {
  const [query, setQuery] = useState(""), [suggestions, setSuggestions] = useState([]), [results, setResults] = useState([]), [phase, setPhase] = useState("idle"), [error, setError] = useState("");
  useEffect(() => { let current = true; if (query.trim().length < 2) { setSuggestions([]); return undefined; } const timer = setTimeout(async () => { try { const data = await karaokeApi.suggestions(query, token); if (current) setSuggestions(data.items || data.suggestions || []); } catch { if (current) setSuggestions([]); } }, 150); return () => { current = false; clearTimeout(timer); }; }, [query, token]);
  const submit = async (event) => { event.preventDefault(); if (!query.trim()) return; setPhase("loading"); setError(""); try { const data = await karaokeApi.partySearch(query, partySearchMode, token); setResults((data.results || []).filter(isKaraokeResult)); setPhase("done"); } catch (e) { setError(e.message); setPhase("error"); } };
  const mutation = async (track, playNow = false) => { try { await onMutate("add", track, playNow); notice(`${playNow ? "เริ่มเล่น" : "เพิ่ม"} “${track.title}” แล้ว`); } catch (e) { notice(e.message || "ทำรายการไม่สำเร็จ"); } };
  return <section className="mobile-section"><h1>ค้นหาเพลง</h1><p>แสดงเฉพาะ Karaoke, Instrumental และ Backing Track</p><form onSubmit={submit} className="mobile-search"><Search size={20}/><input aria-label="ค้นหาเพลง" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ชื่อเพลงหรือศิลปิน" autoComplete="off"/><button className="button primary" type="submit">ค้นหา</button></form>{suggestions.length > 0 && phase !== "loading" && <ul className="suggestions" aria-label="คำแนะนำการค้นหา">{suggestions.slice(0, 6).map((item) => <li key={item.query || item}><button onClick={() => setQuery(item.query || item)}>{item.query || item}</button></li>)}</ul>}
    <div className="results" aria-live="polite">{phase === "idle" && <Empty title="อยากร้องเพลงอะไรดี?" detail="พิมพ์อย่างน้อย 2 ตัวอักษรเพื่อรับคำแนะนำ"/>}{phase === "loading" && <p className="loading"><LoaderCircle className="spin"/>กำลังค้นหา…</p>}{phase === "error" && <Empty title="ค้นหาไม่สำเร็จ" detail={error}/>} {phase === "done" && results.length === 0 && <Empty title="ไม่พบคาราโอเกะหรือเพลงประกอบ" detail="ลองเปลี่ยนคำค้นอีกนิด"/>}{results.map((track) => <ResultRow key={track.videoId} track={normalizeTrack(track)} onAdd={(t) => mutation(t)} onPlay={(t) => mutation(t, true)}/>)}</div></section>;
}

function SortableRow({ track, index, count, onMove, onDelete, onPlayNow }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: track.queueId });
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={isDragging ? "dragging" : ""}><button className="drag-handle" aria-label={`ลากเพื่อย้าย ${track.title}`} {...attributes} {...listeners}><GripVertical/></button><span>{index + 1}</span><img src={track.thumbnailUrl} alt=""/><div><strong>{track.title}</strong><small>{track.requestedBy || track.channelTitle || "ผู้ร่วมร้อง"}</small></div><div className="queue-row-actions"><IconButton label="เลื่อนขึ้น" disabled={!index} onClick={() => onMove(track, index - 1)}><ChevronUp size={17}/></IconButton><IconButton label="เลื่อนลง" disabled={index === count - 1} onClick={() => onMove(track, index + 1)}><ChevronDown size={17}/></IconButton><IconButton label="เล่นทันที" onClick={() => onPlayNow(track)}><Play size={17}/></IconButton><IconButton label={`ลบ ${track.title}`} onClick={() => onDelete(track)}><Trash2 size={17}/></IconButton></div></li>;
}

function Confirm({ title, detail, onCancel, onConfirm }) { const panel = useRef(null), primary = useRef(null); useDialog(true, onCancel, panel, primary); return <div className="modal-scrim"><section className="modal confirm" ref={panel} role="dialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">{title}</h2><p>{detail}</p><div><button className="button secondary" onClick={onCancel}>ยกเลิก</button><button className="button danger" ref={primary} onClick={onConfirm}>ยืนยัน</button></div></section></div>; }

function QueueTab({ queue, onMutate, notice }) {
  const [confirm, setConfirm] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const commit = async (action, track, index) => { try { await onMutate(action, track, index); notice(action === "delete" ? `ลบ “${track.title}” แล้ว` : action === "playNow" ? `กำลังเล่น “${track.title}”` : `ย้าย “${track.title}” แล้ว`); } catch (e) { notice(e.message || "คิวถูกเปลี่ยนโดยคนอื่น ลองใหม่อีกครั้ง"); } finally { setConfirm(null); } };
  const dragEnd = ({ active, over }) => { if (!over || active.id === over.id) return; const from = queue.findIndex((item) => item.queueId === active.id), to = queue.findIndex((item) => item.queueId === over.id); commit("reorder", queue[from], to); };
  return <section className="mobile-section queue-tab"><h1>คิวเพลง <span>({queue.length})</span></h1><p>ทุกคนจัดลำดับ ลบ ข้าม หรือเล่นทันทีได้</p>{queue.length ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={queue.map((item) => item.queueId)} strategy={verticalListSortingStrategy}><ol>{queue.map((track, index) => <SortableRow key={track.queueId} track={track} index={index} count={queue.length} onMove={(t, to) => commit("reorder", t, to)} onDelete={(t) => setConfirm({ action: "delete", track: t })} onPlayNow={(t) => setConfirm({ action: "playNow", track: t })}/>)}</ol></SortableContext></DndContext> : <Empty title="คิวว่าง" detail="ไปที่แท็บค้นหาเพื่อเพิ่มเพลงต่อไป"/>}{confirm && <Confirm title={confirm.action === "delete" ? "ลบเพลงออกจากคิว?" : "เล่นเพลงนี้ทันที?"} detail={`“${confirm.track.title}”${confirm.action === "playNow" ? " จะข้ามเพลงปัจจุบัน" : " จะถูกนำออกจากคิว"}`} onCancel={() => setConfirm(null)} onConfirm={() => commit(confirm.action, confirm.track)}/>}</section>;
}

function Join({ onJoin, hasLaunchToken }) { const [pin, setPin] = useState(""), [name, setName] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false); const submit = async (e) => { e.preventDefault(); setLoading(true); try { await onJoin(pin, name); } catch (err) { setError(err.message); } finally { setLoading(false); } }; return <main className="join"><Mic2 size={38}/><h1>เข้าร่วม KaraokeStation</h1><p>{hasLaunchToken ? "QR ยืนยัน session แล้ว — ใส่ชื่อเพื่อเริ่มเลือกเพลง" : "สแกน QR จากหน้าจอทีวี แล้วกรอกรหัส session"}</p><form onSubmit={submit}>{!hasLaunchToken && <label>รหัส session<input aria-label="รหัส session" inputMode="numeric" maxLength="6" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}/></label>}<label>ชื่อของคุณ<input aria-label="ชื่อของคุณ" maxLength="20" value={name} onChange={(e) => setName(e.target.value)}/></label>{error && <p className="form-error">{error}</p>}<button className="button primary wide" disabled={loading || (!hasLaunchToken && pin.length !== 6) || name.trim().length < 2}>{loading ? "กำลังเข้า…" : "เข้าร่วม"}</button></form></main>; }

function Party({ state, setState, partyToken, onJoined, onExpired }) {
  const [tab, setTab] = useState("search"), [notice, setNotice] = useState(""), [confirmSkip, setConfirmSkip] = useState(false), [fairQueueSaving, setFairQueueSaving] = useState(false);
  const token = partyToken;
  const guard = async (request) => {
    try { return await request(); }
    catch (error) { if (isInvalidPartySessionError(`${error.code || ""} ${error.message || ""}`)) onExpired(); throw error; }
  };
  const join = async (pin, name) => {
    const data = await (state.launchToken ? karaokeApi.joinParty(state.launchToken, name, "joinToken") : karaokeApi.joinParty(pin, name));
    setState((old) => ({ ...old, launchToken: "" }));
    onJoined(data.token);
  };
  const mutate = async (action, track, index) => guard(async () => {
    if (action === "add") {
      const added = await karaokeApi.partyQueue(track, token);
      return index && needsPlayNowAfterAdd(added) ? karaokeApi.partyPlayNow(added.item.id, token, added.revision) : added;
    }
    if (action === "delete") return karaokeApi.partyRemove(track.queueId, token, state.revision);
    if (action === "reorder") return karaokeApi.partyReorder(track.queueId, index, token, state.revision);
    if (action === "playNow") return karaokeApi.partyPlayNow(track.queueId, token, state.revision);
    return karaokeApi.partySkip(token, state.revision);
  });
  if (!token) return <Join onJoin={join} hasLaunchToken={Boolean(state.launchToken)}/>;
  const skip = async () => { try { await mutate("skip"); setNotice("ข้ามเพลงแล้ว"); } catch (error) { setNotice(error.message); } finally { setConfirmSkip(false); } };
  const toggleFairQueue = async () => { if (fairQueueSaving) return; const enabled = !Boolean(state.settings?.fairQueue); setFairQueueSaving(true); try { const data = await karaokeApi.partySettings({ fairQueue: enabled }, token); setState((old) => ({ ...old, revision: Math.max(old.revision, data.revision ?? old.revision), settings: { ...old.settings, ...(data.settings || {}) } })); setNotice(enabled ? "เปิดคิวผลัดกันร้องแล้ว" : "ปิดคิวผลัดกันร้องแล้ว"); } catch (error) { setNotice(error.message || "เปลี่ยนโหมดคิวไม่สำเร็จ"); } finally { setFairQueueSaving(false); } };
  return <main className="party"><header><a href="/display" className="party-brand"><Music2/>KaraokeStation</a><span className={state.connected ? "connected" : "disconnected"}>{state.connected ? <Wifi size={15}/> : <WifiOff size={15}/>} {state.connected ? "เชื่อมต่อ" : "ขาดการเชื่อมต่อ"}</span></header><section className="now-playing"><span>กำลังเล่นบนทีวี</span><strong>{state.player.track?.title || "ยังไม่มีเพลง"}</strong><button className="skip-link" onClick={() => setConfirmSkip(true)} disabled={!state.player.track}>Skip</button></section><div className="party-fair-queue-controls"><button className={`button secondary party-fair-queue-toggle${state.settings?.fairQueue ? " active" : ""}`} aria-pressed={Boolean(state.settings?.fairQueue)} onClick={toggleFairQueue} disabled={fairQueueSaving}><ArrowUpDown size={16}/>{state.settings?.fairQueue ? "คิวผลัดกันร้อง: เปิด" : "เปิดคิวผลัดกันร้อง"}</button></div>{tab === "search" ? <SearchTab token={token} onMutate={mutate} notice={setNotice}/> : <QueueTab queue={state.queue} onMutate={mutate} notice={setNotice}/>}<nav className="bottom-tabs" aria-label="เมนูมือถือ"><button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}><Search/>ค้นหา</button><button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}><ListMusic/>คิว {state.queue.length}</button></nav>{confirmSkip && <Confirm title="ข้ามเพลงนี้?" detail={`“${state.player.track.title}” จะหยุดและเริ่มเพลงถัดไป`} onCancel={() => setConfirmSkip(false)} onConfirm={skip}/>}<Toast toast={notice} onClose={() => setNotice("")}/></main>;
}

function applyQueue(payload, setState, playerPatch = {}) { const queue = normalizeQueue(payload.queue || payload); setState((old) => ({ ...old, revision: queue.revision, queue: queue.items, player: { ...old.player, track: queue.current || null, ...playerPatch } })); }

export default function App() {
  const [state, setState] = useState({ connected: false, queue: [], revision: 0, player: emptyPlayer, settings: {}, party: null, eventMessage: "", launchToken: consumeLaunchToken() });
  const [partyToken, setPartyToken] = useState(() => sessionStorage.getItem("karaokeLaunchToken") || "");
  const route = location.pathname === "/party" || location.pathname.startsWith("/remote") ? "party" : "display";
  useEffect(() => {
    let stop = false;
    const applyIncoming = (incoming) => {
      if (!incoming) return;
      const queue = normalizeQueue(incoming);
      setState((old) => ({ ...old, queue: queue.items, revision: queue.revision, player: { ...old.player, track: queue.current || null }, settings: incoming.settings || old.settings }));
    };
    const receiveSocket = (event) => {
      if (event.type === "connection") setState((old) => ({ ...old, connected: event.connected }));
      if (["host-state", "party-state"].includes(event.type)) applyIncoming(event.state);
      if (event.type === "party-action") {
        const action = { add: "เพิ่ม", remove: "ลบ", reorder: "ย้าย", skip: "ข้าม", play_now: "เลือกเล่นทันที" }[event.action.action] || "จัดการ";
        setState((old) => ({ ...old, eventMessage: `${event.action.actor} ${action} “${event.action.track?.title || "เพลง"}”` }));
      }
      if (event.type === "connection" && !event.connected && isInvalidPartySessionError(event.error)) {
        sessionStorage.removeItem("karaokeLaunchToken");
        setPartyToken("");
      }
    };
    const disconnect = route === "party" && !partyToken ? () => {} : connectStation(receiveSocket, route === "party" ? { partyToken } : {});
    if (route === "display") {
      (async () => {
        try {
          const [snapshot, party] = await Promise.all([karaokeApi.state(), karaokeApi.party()]);
          if (stop) return;
          const queue = normalizeQueue(snapshot);
          setState((old) => ({ ...old, queue: queue.items, revision: queue.revision, player: { ...old.player, track: queue.current, volume: snapshot.settings?.defaultVolume || 75 }, settings: snapshot.settings || {}, party, connected: true }));
          if (new URLSearchParams(location.search).get("newSession") === "1" || !party?.sessionId) {
            const created = await karaokeApi.startPartySession();
            if (!stop) { history.replaceState(null, "", "/display"); setState((old) => ({ ...old, party: { ...old.party, ...created } })); }
          }
        } catch { if (!stop) setState((old) => ({ ...old, connected: false })); }
      })();
    } else if (partyToken) {
      karaokeApi.partyStatus().then((status) => { if (!stop) { applyIncoming(status); setState((old) => ({ ...old, connected: true })); } }).catch(() => { if (!stop) setState((old) => ({ ...old, connected: false })); });
    } else {
      setState((old) => ({ ...old, connected: false }));
    }
    return () => { stop = true; disconnect(); };
  }, [route, partyToken]);
  const rotateParty = async () => { try { const data = await karaokeApi.rotateParty(); setState((old) => ({ ...old, party: { ...old.party, ...data }, eventMessage: "สร้าง QR / session ใหม่แล้ว" })); } catch (e) { setState((old) => ({ ...old, eventMessage: e.message })); } };
  state.rotateParty = rotateParty;
  const joined = (token) => { sessionStorage.setItem("karaokeLaunchToken", token); setPartyToken(token); };
  const expired = () => { sessionStorage.removeItem("karaokeLaunchToken"); setPartyToken(""); setState((old) => ({ ...old, eventMessage: "session หมดอายุ โปรดเข้าร่วมใหม่" })); };
  return route === "party" ? <Party state={state} setState={setState} partyToken={partyToken} onJoined={joined} onExpired={expired}/> : <Display state={state} setState={setState}/>;
}

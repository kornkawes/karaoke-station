(() => {
  'use strict';
  const KEY = 'karaoke-station-preview-session-v3';
  const LIMIT = 100;
  const tracks = [
    { id: 'rudu', title: 'ฤดูที่ฉันเหงา', artist: 'Flure', art: 'cover-sky', duration: '04:27' },
    { id: 'duangjai', title: 'ดวงใจ', artist: 'PALMY', art: 'cover-sky', duration: '03:48' },
    { id: 'kitmaithueng', title: 'คิด(แต่ไม่)ถึง', artist: 'Tilly Birds', art: 'cover-sun', duration: '04:11' },
    { id: 'lalaloi', title: 'ลาลาลอย', artist: 'The TOYS', art: 'cover-pink', duration: '03:30' },
    { id: 'janjao', title: 'จันทร์เจ้า', artist: 'Slot Machine', art: 'cover-ink', duration: '04:18' },
    { id: 'kidluek', title: 'คิดลึก', artist: 'TATTOO COLOUR', art: 'cover-sun', duration: '03:54' }
  ];
  const trackIds = new Set(tracks.map((track) => track.id));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const nameOf = (value, fallback = 'Nut') => typeof value === 'string' && value.trim() ? value.trim().slice(0, 24) : fallback;
  const item = (trackId, requestedBy) => trackIds.has(trackId) ? { trackId, requestedBy: nameOf(requestedBy) } : null;
  const defaultState = () => ({
    version: 3, room: 'AH-2248', displayName: 'Nut', fairQueue: true, playing: true, volume: 72, muted: false,
    current: item('rudu', 'Ploy'),
    queue: [item('duangjai', 'Mew'), item('kitmaithueng', 'Nut'), item('lalaloi', 'Jane'), item('janjao', 'Nut')],
    history: [], favorites: []
  });
  const validItem = (value) => value && typeof value === 'object' ? item(value.trackId, value.requestedBy) : null;
  const roundRobin = (queue, currentRequester = '') => {
    const groups = new Map();
    queue.forEach((entry) => { if (!groups.has(entry.requestedBy)) groups.set(entry.requestedBy, []); groups.get(entry.requestedBy).push(entry); });
    const singers = [...groups.keys()];
    if (singers.length < 2) return queue;
    const previousIndex = singers.indexOf(currentRequester);
    const order = previousIndex < 0 ? singers : [...singers.slice(previousIndex + 1), ...singers.slice(0, previousIndex + 1)];
    const result = [];
    while (result.length < queue.length) order.forEach((singer) => { const next = groups.get(singer).shift(); if (next) result.push(next); });
    return result;
  };
  const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object') return defaultState();
    const base = defaultState();
    const current = raw.current === null ? null : validItem(raw.current) || base.current;
    const queueRaw = Array.isArray(raw.queue) ? raw.queue.slice(0, LIMIT).map(validItem).filter(Boolean) : base.queue;
    const history = Array.isArray(raw.history) ? raw.history.slice(0, LIMIT).map((entry) => {
      const safe = validItem(entry); if (!safe) return null;
      return { ...safe, status: entry.status === 'interrupted' ? 'interrupted' : entry.status === 'skipped' ? 'skipped' : 'completed', at: Number.isFinite(entry.at) ? entry.at : Date.now() };
    }).filter(Boolean) : [];
    const favorites = Array.isArray(raw.favorites) ? [...new Set(raw.favorites.filter((id) => trackIds.has(id)))].slice(0, LIMIT) : [];
    const state = { version: 3, room: typeof raw.room === 'string' && /^AH-\d{4}$/.test(raw.room) ? raw.room : base.room, displayName: nameOf(raw.displayName), fairQueue: typeof raw.fairQueue === 'boolean' ? raw.fairQueue : true, playing: Boolean(current) && (typeof raw.playing === 'boolean' ? raw.playing : true), volume: Number.isFinite(raw.volume) ? Math.max(0, Math.min(100, Math.round(raw.volume))) : 72, muted: typeof raw.muted === 'boolean' ? raw.muted : false, current, queue: queueRaw, history, favorites };
    return state;
  };
  let memory = defaultState();
  const listeners = new Set();
  let channel;
  try { channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('karaoke-station-preview-v3') : null; } catch (_) { channel = null; }
  const read = () => { try { const raw = localStorage.getItem(KEY); return raw ? sanitize(JSON.parse(raw)) : memory; } catch (_) { return memory; } };
  const notify = () => { const snapshot = clone(memory); listeners.forEach((listener) => listener(snapshot)); };
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch (_) {} try { channel?.postMessage(memory); } catch (_) {} notify(); };
  const update = (mutator) => { const draft = clone(read()); mutator(draft); memory = sanitize(draft); persist(); return clone(memory); };
  const archive = (draft, entry, status) => { if (entry) draft.history.unshift({ ...entry, status, at: Date.now() }); draft.history = draft.history.slice(0, LIMIT); };
  const api = {
    LIMIT, tracks: clone(tracks), get: () => clone(read()), track: (id) => clone(tracks.find((track) => track.id === id) || null), subscribe: (listener) => { listeners.add(listener); listener(clone(read())); return () => listeners.delete(listener); },
    reset: () => { memory = defaultState(); persist(); return clone(memory); },
    newRoom: () => { const previous = read(); memory = { ...defaultState(), room: `AH-${1000 + ((Number(previous.room.slice(3)) - 1000 + 1) % 9000)}`, displayName: previous.displayName, current: null, playing: false, queue: [], history: [], favorites: previous.favorites }; persist(); return clone(memory); },
    setName: (displayName) => update((draft) => { draft.displayName = nameOf(displayName, draft.displayName); }),
    setFair: (enabled) => update((draft) => { const wasEnabled = draft.fairQueue; draft.fairQueue = Boolean(enabled); if (!wasEnabled && draft.fairQueue) draft.queue = roundRobin(draft.queue, draft.current?.requestedBy); }),
    setFavorite: (trackId, enabled) => update((draft) => { if (!trackIds.has(trackId)) return; draft.favorites = enabled ? [...new Set([...draft.favorites, trackId])].slice(0, LIMIT) : draft.favorites.filter((id) => id !== trackId); }),
    add: (trackId, requestedBy) => {
      let result = { ok: false, promoted: false };
      update((draft) => { const entry = item(trackId, requestedBy || draft.displayName); if (!entry) return; if (!draft.current) { draft.current = entry; draft.playing = true; result = { ok: true, promoted: true, entry }; return; } if (draft.queue.length >= LIMIT) { result = { ok: false, full: true }; return; } draft.queue.push(entry); if (draft.fairQueue) draft.queue = roundRobin(draft.queue, draft.current.requestedBy); result = { ok: true, entry }; });
      return result;
    },
    skip: () => { let result = { ok: false }; update((draft) => { if (!draft.current) return; archive(draft, draft.current, 'skipped'); draft.current = draft.queue.shift() || null; draft.playing = Boolean(draft.current); result = { ok: true, current: draft.current }; }); return result; },
    complete: () => { let result = { ok: false, empty: false }; update((draft) => { if (!draft.current) { result = { ok: false, empty: true }; return; } archive(draft, draft.current, 'completed'); draft.current = draft.queue.shift() || null; draft.playing = Boolean(draft.current); result = { ok: true, empty: !draft.current, current: draft.current }; }); return result; },
    playNow: (index) => { let result = { ok: false }; update((draft) => { if (!Number.isInteger(index) || index < 0 || index >= draft.queue.length) return; const next = draft.queue.splice(index, 1)[0]; archive(draft, draft.current, 'interrupted'); draft.current = next; draft.playing = true; result = { ok: true, current: next }; }); return result; },
    remove: (index) => update((draft) => { if (Number.isInteger(index) && index >= 0 && index < draft.queue.length) draft.queue.splice(index, 1); }),
    move: (index, direction) => update((draft) => { if (!Number.isInteger(index) || ![-1, 1].includes(direction)) return; const target = index + direction; if (index < 0 || target < 0 || index >= draft.queue.length || target >= draft.queue.length) return; [draft.queue[index], draft.queue[target]] = [draft.queue[target], draft.queue[index]]; }),
    setPlayback: (playing) => update((draft) => { draft.playing = Boolean(playing); }),
    setMuted: (muted) => update((draft) => { draft.muted = Boolean(muted); }),
    setVolume: (volume) => update((draft) => { draft.volume = Math.max(0, Math.min(100, Math.round(Number(volume) || 0))); if (draft.volume > 0) draft.muted = false; })
  };
  memory = read();
  if (channel) channel.addEventListener('message', (event) => { memory = sanitize(event.data); try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch (_) {} notify(); });
  window.addEventListener('storage', (event) => { if (event.key === KEY) { try { memory = event.newValue ? sanitize(JSON.parse(event.newValue)) : defaultState(); } catch (_) { memory = defaultState(); } notify(); } });
  window.KaraokePreview = api;
})();

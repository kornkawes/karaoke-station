(() => {
  'use strict';
  if (document.body.dataset.page !== 'mobile') return;
  const api = window.KaraokePreview;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const icon = (name) => ({ expand: '<path d="m6 15 6-6 6 6"></path>', play: '<path d="m9 6 8 6-8 6z"></path>', pause: '<path d="M9 6v12M15 6v12"></path>', next: '<path d="m9 5 7 7-7 7"></path><path d="M5 5v14"></path>', volume: '<path d="M4 10h4l5-4v12l-5-4H4z"></path><path d="M16 9c1.3 1.7 1.3 4.3 0 6"></path>', mute: '<path d="M4 10h4l5-4v12l-5-4H4z"></path><path d="m16 10 4 4m0-4-4 4"></path>', close: '<path d="m7 7 10 10M17 7 7 17"></path>', plus: '<path d="M12 5v14M5 12h14"></path>', up: '<path d="m7 14 5-5 5 5"></path>', down: '<path d="m7 10 5 5 5-5"></path>', redo: '<path d="M7 9H4V6"></path><path d="M4 9a8 8 0 1 1-1 7"></path>', copy: '<rect x="8" y="8" width="11" height="12" rx="1"></rect><path d="M16 8V5H5v11h3"></path>', check: '<path d="m5 12 4 4L19 6"></path>' }[name] || '');
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icon(name)}</svg>`;
  const ui = { view: location.hash === '#queue' ? 'queue' : location.hash === '#history' ? 'history' : 'search', filter: 'all', query: '', sheet: null };
  try { if (sessionStorage.getItem('karaoke-preview-joined') !== 'yes') ui.sheet = 'join'; } catch (_) { ui.sheet = 'join'; }
  let openerSelector = '[data-open-remote]';
  const content = $('#phoneContent'); const dock = $('#nowDock'); const badge = $('#queueBadge'); const sheets = $('#sheetRoot');
  const toast = (message) => { const node = $('.toast'); node.textContent = message; node.classList.add('show'); clearTimeout(window.previewToastTimer); window.previewToastTimer = setTimeout(() => node.classList.remove('show'), 2500); };
  const track = (entry) => entry ? api.track(entry.trackId) : null;
  const itemRow = (entry, index, state) => { const music = track(entry); return `<article class="queue-item"><span class="queue-pos">${String(index + 1).padStart(2, '0')}</span><div class="cover ${music.art}"></div><div><strong>${esc(music.title)}</strong><small>${esc(music.artist)} · ขอโดย ${esc(entry.requestedBy)}</small><div class="queue-controls"><button data-move="up" data-index="${index}" ${index === 0 ? 'disabled' : ''} aria-label="เลื่อน ${esc(music.title)} ขึ้น">${svg('up')}</button><button data-move="down" data-index="${index}" ${index === state.queue.length - 1 ? 'disabled' : ''} aria-label="เลื่อน ${esc(music.title)} ลง">${svg('down')}</button><button class="play-now" data-play-now="${index}">เล่นทันที</button><button class="remove" data-remove="${index}" aria-label="นำ ${esc(music.title)} ออกจากคิว">${svg('close')}</button></div></div></article>`; };
  const resultRow = (music, state) => `<li class="song-row"><div class="cover ${music.art}"></div><div class="song-info"><strong>${esc(music.title)}</strong><small>${esc(music.artist)}</small><span>${music.duration} · จะขอในชื่อ ${esc(state.displayName)}</span></div><div class="song-actions"><button class="favorite ${state.favorites.includes(music.id) ? 'is-favorite' : ''}" data-favorite="${music.id}" aria-label="บันทึกเพลงโปรด">${state.favorites.includes(music.id) ? '★' : '☆'}</button><button class="add-button" data-add="${music.id}" aria-label="เพิ่ม ${esc(music.title)}">${svg('plus')}</button></div></li>`;
  const drawSearch = (state) => {
    const query = ui.query.trim().toLowerCase(); const url = /^https?:\/\//.test(query) || query.includes('youtu');
    const knownUrl = /youtu\.be\/after-hours-demo|youtube\.com\/watch\?v=after-hours-demo/.test(query);
    const source = ui.filter === 'favorites' ? api.tracks.filter((music) => state.favorites.includes(music.id)) : api.tracks;
    const matches = query && !url ? source.filter((music) => `${music.title} ${music.artist}`.toLowerCase().includes(query)) : source;
    const body = url ? knownUrl ? `<p class="demo-callout"><strong>ลิงก์ตัวอย่างที่รู้จัก:</strong> ไม่เรียก YouTube และจะแสดงเพลงจำลองด้านล่าง</p><ul class="song-list">${resultRow(api.track('rudu'), state)}</ul>` : '<div class="empty-state"><b>ยังเชื่อม YouTube ไม่ได้</b>Preview นี้ไม่ส่งลิงก์ออกไป โปรดลองค้นหาจากชุดข้อมูลตัวอย่าง หรือใช้ <code>youtu.be/after-hours-demo</code></div>' : matches.length ? `<div class="result-heading"><p>${ui.filter === 'favorites' ? 'เพลงโปรดของฉัน' : 'เพลงที่น่าจะใช่'}</p><small>${matches.length} รายการ</small></div><ul class="song-list">${matches.map((music) => resultRow(music, state)).join('')}</ul>` : '<div class="empty-state"><b>ยังไม่พบเพลง</b>ลองค้นหาด้วยชื่อเพลงหรือศิลปินอื่น</div>';
    content.innerHTML = `<section class="mobile-hero"><p class="eyebrow">KARAOKE STATION <span class="preview-label">· SAME-BROWSER PREVIEW</span></p><h1>คืนนี้<br /><em>ร้องเพลงไหนดี?</em></h1></section><form class="search-box" id="searchForm"><input id="songSearch" autocomplete="off" value="${esc(ui.query)}" aria-label="ค้นหาชื่อเพลง ศิลปิน หรือลิงก์ YouTube" placeholder="ชื่อเพลง, ศิลปิน หรือ YouTube URL" /><button aria-label="ค้นหา"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg></button></form><div class="chips" aria-label="ตัวกรองเพลง"><button class="${ui.filter === 'all' ? 'active' : ''}" data-filter="all">ทั้งหมด</button><button class="${ui.filter === 'favorites' ? 'active' : ''}" data-filter="favorites">☆ เพลงโปรด (${state.favorites.length})</button></div>${body}<p class="demo-callout"><strong>DESIGN PREVIEW</strong> · action ทั้งหมดจำลองใน browser นี้เท่านั้น ไม่เชื่อม YouTube หรือห้องจริง</p>`;
  };
  const drawQueue = (state) => {
    const rows = state.queue.length ? state.queue.map((entry, index) => itemRow(entry, index, state)).join('') : '<div class="empty-state"><b>คิวว่างอยู่</b>กลับไปค้นหาเพลงที่อยากร้องได้เลย</div>';
    content.innerHTML = `<section class="queue-title"><div><p class="eyebrow">YOUR SESSION</p><h1>คิวของเรา</h1></div><p>${state.queue.length} เพลง</p></section><section class="fair-toggle"><div><strong>ผลัดกันร้อง</strong><small>${state.fairQueue ? 'สลับตามผู้ขอ โดยเริ่มจากคนถัดจากเพลงปัจจุบัน' : 'ปิดอยู่ · จัดลำดับเองได้'}</small></div><button class="switch ${state.fairQueue ? 'on' : ''}" data-fair aria-pressed="${state.fairQueue}" aria-label="เปิดหรือปิดโหมดผลัดกันร้อง"><i></i></button></section>${state.fairQueue ? '<p class="fair-note">เปิดอยู่: เพิ่มเพลงแล้วระบบจะจัดให้ผู้ขอแต่ละคนร้องทีละเพลงต่อรอบ</p>' : ''}<section class="queue-list">${rows}</section><p class="demo-callout"><strong>“เล่นทันที”</strong> จะหยุดเพลงปัจจุบันก่อนจบและบันทึกในประวัติ ย้ายลำดับเองได้เสมอ; ระบบจะจัดผลัดกันร้องอีกครั้งเมื่อเพิ่มเพลงหรือเปิดโหมดนี้</p>`;
  };
  const drawHistory = (state) => {
    const labels = { completed: 'ร้องจบแล้ว', skipped: 'ข้ามแล้ว', interrupted: 'หยุดก่อนจบ' };
    const rows = state.history.length ? state.history.map((entry) => { const music = track(entry); return `<article class="history-row"><div class="cover ${music.art}"></div><div><strong>${esc(music.title)}</strong><small>${esc(music.artist)} · <span class="${entry.status === 'completed' ? 'done' : 'skipped'}">${labels[entry.status]}</span></small></div><button class="readd" data-readd="${music.id}">${svg('redo')} ร้องอีก</button></article>`; }).join('') : '<div class="empty-state"><b>ยังไม่มีประวัติ</b>กด “จบเพลงตัวอย่าง” หรือข้ามเพลงจาก remote เพื่อดูรายการที่นี่</div>';
    content.innerHTML = `<section class="history-title"><p class="eyebrow">THE GOOD PARTS</p><h1>ประวัติการร้อง</h1><p>คืนนี้ · ${state.history.length} เพลง</p></section><section class="history-list">${rows}</section><p class="demo-callout"><strong>ข้อมูลจำลอง</strong> · สถานะจบ, ข้าม และหยุดก่อนจบเปลี่ยนตาม remote จริงใน preview</p>`;
  };
  const drawDock = (state) => { const music = track(state.current); dock.innerHTML = music ? `<div class="dock-art cover ${music.art}"></div><button class="dock-play svg-button" data-dock-play aria-label="${state.playing ? 'พักเพลง' : 'เล่นเพลง'}">${svg(state.playing ? 'pause' : 'play')}</button><button class="dock-details" data-open-remote><span>${state.playing ? 'กำลังเล่น' : 'พักอยู่'}</span><strong>${esc(music.title)}</strong><small>${esc(music.artist)} · ${esc(state.current.requestedBy)}</small></button><button class="dock-expand svg-button" data-open-remote aria-label="เปิด remote">${svg('expand')}</button>` : `<div class="dock-art waiting-art"></div><div class="dock-play disabled">${svg('play')}</div><button class="dock-details" data-open-remote><span>WAITING</span><strong>รอเพลงแรก</strong><small>เพิ่มเพลงจากหน้าค้นหาได้เลย</small></button><button class="dock-expand svg-button" data-open-remote aria-label="เปิด remote">${svg('expand')}</button>`; };
  const drawSheet = (state) => {
    if (!ui.sheet) { sheets.innerHTML = ''; return; }
    const music = track(state.current); let panel = '';
    if (ui.sheet === 'join') panel = `<section class="remote-sheet compact-sheet" role="dialog" aria-modal="true" aria-labelledby="joinTitle"><p class="eyebrow">JOIN ROOM · DESIGN PREVIEW</p><h2 id="joinTitle">เข้าห้อง ${esc(state.room)}</h2><p class="sheet-subtitle">ใส่ชื่อที่จะใช้ขอเพลง</p><form id="joinForm"><label class="copy-field">ชื่อของคุณ<input id="joinName" maxlength="24" required value="${esc(state.displayName)}" /></label><button class="sheet-action" type="submit">เข้าร่วมห้องตัวอย่าง</button></form><p class="sheet-note">จำลองขั้นตอนเข้าห้องเท่านั้น ยังไม่ใช้ QR หรือบัญชีผู้ใช้จริง</p></section>`;
    if (ui.sheet === 'remote') panel = `<section class="remote-sheet" role="dialog" aria-modal="true" aria-labelledby="remoteTitle"><button class="sheet-close" data-close-sheet aria-label="ปิด">${svg('close')}</button><p class="eyebrow">MOBILE REMOTE · SIMULATED</p><h2 id="remoteTitle">${music ? esc(music.title) : 'รอเพลงแรก'}</h2><p class="sheet-subtitle">${music ? `${esc(music.artist)} · ร้องโดย ${esc(state.current.requestedBy)}` : 'ยังไม่มีเพลงกำลังเล่น'}</p><div class="remote-primary"><button data-play-toggle ${music ? '' : 'disabled'} aria-label="${state.playing ? 'พักเพลง' : 'เล่นเพลง'}">${svg(state.playing ? 'pause' : 'play')}</button><button data-skip ${music ? '' : 'disabled'}>${svg('next')} ข้ามเพลง</button><button data-complete ${music ? '' : 'disabled'}>${svg('check')} จบเพลงตัวอย่าง</button></div><div class="volume-row"><button data-mute ${music ? '' : 'disabled'} aria-label="${state.muted ? 'เปิดเสียง' : 'ปิดเสียง'}">${svg(state.muted ? 'mute' : 'volume')}</button><label>ระดับเสียง <output>${state.muted ? 0 : state.volume}</output><input data-volume type="range" min="0" max="100" value="${state.muted ? 0 : state.volume}" ${music ? '' : 'disabled'} /></label></div><p class="sheet-note">Remote นี้เปลี่ยนเฉพาะ state ตัวอย่าง ไม่มีเสียงหรือวิดีโอจริง</p></section>`;
    if (ui.sheet === 'share') panel = `<section class="remote-sheet compact-sheet" role="dialog" aria-modal="true" aria-labelledby="shareTitle"><button class="sheet-close" data-close-sheet aria-label="ปิด">${svg('close')}</button><p class="eyebrow">INVITATION · DEMO</p><h2 id="shareTitle">ชวนเพื่อนเข้าห้อง</h2><p class="sheet-subtitle">KARAOKE STATION · ห้อง ${esc(state.room)}</p><label class="copy-field">ข้อความตัวอย่าง<input id="inviteText" readonly value="มาร้องเพลงที่ Karaoke Station ห้อง ${esc(state.room)} (Design Preview)" /></label><button class="sheet-action" data-copy-invite>${svg('copy')} คัดลอกข้อความตัวอย่าง</button><p class="sheet-note">ยังไม่มีลิงก์เข้าห้องจริง และปุ่มนี้ไม่ส่งข้อความให้ใคร</p></section>`;
    if (ui.sheet === 'settings') panel = `<section class="remote-sheet compact-sheet" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><button class="sheet-close" data-close-sheet aria-label="ปิด">${svg('close')}</button><p class="eyebrow">ROOM MANAGEMENT · DEMO</p><h2 id="settingsTitle">ตั้งค่าห้อง</h2><p class="sheet-subtitle">สำหรับ role host ใน preview นี้เท่านั้น</p><form id="nameForm"><label class="copy-field">ชื่อที่แสดง<input id="displayName" maxlength="24" value="${esc(state.displayName)}" /></label><button class="sheet-action" type="submit">บันทึกชื่อ</button></form><button class="sheet-danger" data-new-room>สร้างห้องใหม่</button><p class="sheet-note">จะล้างเพลง คิว และประวัติเฉพาะ browser preview นี้ หลังยืนยัน</p></section>`;
    sheets.innerHTML = `<div class="sheet-backdrop" data-close-sheet></div>${panel}`;
  };
  const render = (state = api.get()) => {
    const active = document.activeElement;
    const selector = active?.id ? `#${active.id}` : active?.dataset ? Object.keys(active.dataset).filter((key) => key !== 'index').map((key) => `[data-${key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())}]`)[0] : null;
    const inputValue = active?.matches('input:not([type=range])') ? active.value : null;
    const start = active?.selectionStart;
    if (active?.id === 'songSearch') ui.query = active.value;
    const hadSheet = Boolean(sheets.querySelector('[role=dialog]'));
    badge.textContent = String(state.queue.length);
    const roomLabel = $('.phone-header p'); if (roomLabel) roomLabel.innerHTML = `<span class="status-dot"></span> ${esc(state.room)} · ห้องตัวอย่าง`;
    $$('.bottom-nav button').forEach((button) => { button.classList.toggle('active', button.dataset.view === ui.view); button.setAttribute('aria-current', button.dataset.view === ui.view ? 'page' : 'false'); });
    ({ search: drawSearch, queue: drawQueue, history: drawHistory })[ui.view](state);
    drawDock(state); drawSheet(state);
    $('.phone').inert = Boolean(ui.sheet);
    const match = selector ? $(selector, ui.sheet ? sheets : document) : null;
    if (match && active !== document.body) { if (inputValue !== null) match.value = inputValue; match.focus({preventScroll:true}); if (start !== null && match.setSelectionRange) try { match.setSelectionRange(start, start); } catch (_) {} }
    else if (ui.sheet) { const target = $('input, button', sheets); target?.focus({preventScroll:true}); }
    else if (hadSheet) $(openerSelector)?.focus({preventScroll:true});
  };
  const openSheet = (name, selector) => { openerSelector = selector; ui.sheet = name; render(); };
  const closeSheet = () => { if (ui.sheet === 'join') return; ui.sheet = null; render(); };
  sheets.addEventListener('click', (event) => { if (event.target.matches('.sheet-backdrop')) closeSheet(); });
  document.addEventListener('keydown', (event) => {
    if (!ui.sheet) return;
    if (event.key === 'Escape') { event.preventDefault(); closeSheet(); }
    if (event.key !== 'Tab') return;
    const nodes = $$('button:not(:disabled), input:not(:disabled)', sheets);
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const add = (id) => { const result = api.add(id, api.get().displayName); if (!result.ok) { toast('คิวตัวอย่างเต็มแล้ว (สูงสุด 100 เพลง)'); return; } toast(result.promoted ? 'เริ่มเล่นเพลงแรกในตัวอย่างแล้ว' : 'เพิ่มเพลงในคิวแล้ว'); };
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.view) { ui.view = button.dataset.view; render(); return; }
    if (button.dataset.filter) { ui.filter = button.dataset.filter; ui.query = ''; render(); return; }
    if (button.dataset.add) return add(button.dataset.add);
    if (button.dataset.favorite) { const state = api.get(); api.setFavorite(button.dataset.favorite, !state.favorites.includes(button.dataset.favorite)); return; }
    if (button.dataset.fair !== undefined) { api.setFair(!api.get().fairQueue); return; }
    if (button.dataset.move) return api.move(Number(button.dataset.index), button.dataset.move === 'up' ? -1 : 1);
    if (button.dataset.remove !== undefined) { api.remove(Number(button.dataset.remove)); toast('นำเพลงออกจากคิวแล้ว'); return; }
    if (button.dataset.playNow !== undefined) { const result = api.playNow(Number(button.dataset.playNow)); if (result.ok) toast('เริ่มเล่นเพลงที่เลือกแล้ว'); return; }
    if (button.dataset.readd) return add(button.dataset.readd);
    if (button.dataset.action === 'share') { openSheet('share', '[data-action=share]'); return; }
    if (button.dataset.action === 'settings') { openSheet('settings', '[data-action=settings]'); return; }
    if (button.dataset.closeSheet !== undefined) { closeSheet(); return; }
    if (button.dataset.openRemote !== undefined) { openSheet('remote', '[data-open-remote]'); return; }
    if (button.dataset.dockPlay !== undefined || button.dataset.playToggle !== undefined) { const state = api.get(); if (state.current) api.setPlayback(!state.playing); return; }
    if (button.dataset.skip !== undefined) { const result = api.skip(); if (result.ok) toast('ข้ามเพลงและบันทึกประวัติแล้ว'); return; }
    if (button.dataset.complete !== undefined) { const result = api.complete(); if (result.ok) toast(result.empty ? 'จบเพลงแล้ว · รอเพลงถัดไป' : 'จบเพลงตัวอย่างแล้ว เล่นเพลงถัดไป'); return; }
    if (button.dataset.mute !== undefined) { api.setMuted(!api.get().muted); return; }
    if (button.dataset.copyInvite !== undefined) { const field = $('#inviteText'); field.select(); if (navigator.clipboard?.writeText) navigator.clipboard.writeText(field.value).then(() => toast('คัดลอกข้อความตัวอย่างแล้ว')).catch(() => toast('เลือกข้อความไว้แล้ว · คัดลอกเองได้')); else toast('เลือกข้อความไว้แล้ว · คัดลอกเองได้'); return; }
    if (button.dataset.newRoom !== undefined) { if (window.confirm('สร้างห้องตัวอย่างใหม่และล้าง state เดิมหรือไม่?')) { api.newRoom(); toast('สร้างห้องตัวอย่างใหม่แล้ว'); } return; }
  });
  document.addEventListener('submit', (event) => { if (event.target.id === 'joinForm') { event.preventDefault(); const value = $('#joinName').value.trim(); if (!value) { toast('กรุณาใส่ชื่อ'); return; } ui.sheet = null; try { sessionStorage.setItem('karaoke-preview-joined', 'yes'); } catch (_) {} api.setName(value); return; } if (event.target.id === 'searchForm') { event.preventDefault(); ui.query = $('#songSearch').value; render(); } if (event.target.id === 'nameForm') { event.preventDefault(); api.setName($('#displayName').value); toast('บันทึกชื่อใน preview แล้ว'); } });
  document.addEventListener('change', (event) => { if (event.target.matches('[data-volume]')) api.setVolume(event.target.value); });
  api.subscribe(render);
})();

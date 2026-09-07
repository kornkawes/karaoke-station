(() => {
  'use strict';
  const stage = document.getElementById('displayStage');
  const button = document.getElementById('fullscreenButton');
  const controls = document.querySelector('[data-controls]');
  const feedback = document.getElementById('displayFeedback');
  let idleTimer;
  let feedbackTimer;
  window.KaraokePreview?.subscribe((state) => {
    const next = state.queue[0];
    const music = next ? window.KaraokePreview.track(next.trackId) : null;
    document.querySelector('.join-corner strong').textContent = state.room;
    document.getElementById('nextSongTitle').textContent = music ? music.title : state.current ? 'ยังไม่มีเพลงถัดไป' : 'รอเพลงแรก';
    document.getElementById('nextSongMeta').textContent = music ? `${music.artist} · ${next.requestedBy}` : 'เพิ่มเพลงจากมือถือ';
    stage.dataset.playing = String(state.playing);
    stage.setAttribute('aria-label', state.current ? `จอเพลงตัวอย่าง · ${state.playing ? 'กำลังเล่น' : 'พักอยู่'}` : 'จอเพลงตัวอย่าง · รอเพลงแรก');
  });
  let suppressFullscreenClickUntil = 0;
  const revealControls = () => { controls.classList.remove('is-idle'); clearTimeout(idleTimer); idleTimer = window.setTimeout(() => controls.classList.add('is-idle'), 2500); };
  const announce = (message) => { feedback.textContent = message; feedback.classList.add('is-visible'); clearTimeout(feedbackTimer); feedbackTimer = window.setTimeout(() => feedback.classList.remove('is-visible'), 2500); };
  const syncFullscreenState = () => { const isFullscreen = document.fullscreenElement === stage; button.setAttribute('aria-label', isFullscreen ? 'ออกจากโหมดเต็มหน้าจอ' : 'เข้าสู่โหมดเต็มหน้าจอ'); button.querySelector('.control-label').textContent = isFullscreen ? 'EXIT FULL SCREEN' : 'FULL SCREEN'; revealControls(); };
  const toggleFullscreen = async () => { try { if (document.fullscreenElement === stage) await document.exitFullscreen(); else if (stage.requestFullscreen) await stage.requestFullscreen(); else announce('เบราว์เซอร์นี้ไม่รองรับโหมดเต็มหน้าจอ'); } catch (_) { announce('ไม่สามารถเปิดโหมดเต็มหน้าจอได้ในขณะนี้'); } };
  button.addEventListener('click', (event) => {
    if (performance.now() < suppressFullscreenClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      suppressFullscreenClickUntil = 0;
      return;
    }
    toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', syncFullscreenState);
  document.addEventListener('pointermove', revealControls, { passive: true });
  document.addEventListener('touchstart', () => {
    const wasIdle = controls.classList.contains('is-idle');
    revealControls();
    if (wasIdle) suppressFullscreenClickUntil = performance.now() + 650;
  }, { passive: true });
  document.addEventListener('focusin', revealControls);
  document.addEventListener('keydown', (event) => { revealControls(); if (event.key === 'Escape' && document.fullscreenElement === stage) document.exitFullscreen().catch(() => announce('ไม่สามารถออกจากโหมดเต็มหน้าจอได้')); });
  revealControls();
})();

(() => {
  'use strict';
  const shape = { roomId: 'string', revision: 'number', current: 'null | { id: string, title: string, requestedBy: string }', queue: [{ id: 'string', title: 'string', requestedBy: 'string' }], settings: { fairQueue: 'boolean' }, history: [{ id: 'string', status: 'completed | skipped | interrupted' }] };
  document.getElementById('contractOutput').textContent = JSON.stringify(shape, null, 2);
  const output = document.getElementById('verifyResult');
  const isLoopback = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; } };
  document.getElementById('verifyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const base = document.getElementById('baseUrl').value.replace(/\/$/, ''); const room = document.getElementById('roomId').value.trim(); const token = document.getElementById('token').value;
    if (!isLoopback(base)) { output.textContent = 'กรอก loopback URL เช่น http://127.0.0.1:3000 ก่อน'; return; }
    if (!room || !token) { output.textContent = 'Room ID และ Bearer token จำเป็นสำหรับการอ่าน queue/history'; return; }
    output.textContent = 'กำลังตรวจสอบแบบอ่านอย่างเดียว…';
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [health, queue, history] = await Promise.all([fetch(`${base}/api/v1/health`), fetch(`${base}/api/v1/rooms/${encodeURIComponent(room)}/queue`, { headers }), fetch(`${base}/api/v1/rooms/${encodeURIComponent(room)}/history`, { headers })]);
      const read = async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) });
      const results = await Promise.all([read(health), read(queue), read(history)]);
      const roomView = results[1].body?.data;
      const shapeOk = results[0].body?.data?.status === 'ok' && roomView && typeof roomView.roomId === 'string' && Number.isInteger(roomView.revision) && Array.isArray(roomView.queue) && typeof roomView.settings?.fairQueue === 'boolean' && Array.isArray(results[2].body?.data?.history);
      output.textContent = results.every((result) => result.status >= 200 && result.status < 300) && shapeOk ? `ผ่าน: health ${results[0].status}, queue ${results[1].status}, history ${results[2].status}\nHosted room shape ตรงกับ preview; ไม่ได้ทดสอบ socket หรือ mutation.` : `พบ response ที่ต้องตรวจ: ${results.map((result) => result.status).join(', ')}`;
    } catch (error) { output.textContent = `เชื่อมต่อไม่สำเร็จ: ${error instanceof Error ? error.message : 'unknown error'}`; }
  });
})();

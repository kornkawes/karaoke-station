# ทดสอบ AFTER HOURS

ระบบนี้ใช้ React HostedApp กับ REST API และ Socket.IO ของ KaraokeStation จริง

- Host: `/display` สร้างห้องและแสดง QR สำหรับมือถือ
- มือถือ: สแกน QR ใส่ชื่อ แล้วค้นหา/วางลิงก์ YouTube เพิ่มเพลง จัดคิว เล่นทันที ข้ามเพลง และเปิดประวัติหรือรายการโปรด
- เล่น/พัก ระดับเสียง ปิดเสียง และผลัดกันร้องควบคุมจากมือถือ โดย Host รับสถานะผ่าน Socket.IO
- ปุ่มผลัดกันร้องใช้ track 36×22px และพื้นที่กดอย่างน้อย 44px
- พรีวิว React รุ่นก่อนยังเปิดเทียบได้ที่ `/display?ui=preview`; HTML ตัวอย่างอยู่ใน `design-preview/`

## ขอบเขต deploy

ใช้ repo `https://github.com/kornkawes/karaoke-station` และ Render service `srv-d9msbje417fc73c4bsf0` ที่ `https://karaoke-station.onrender.com` เท่านั้น

`kornkawes/kavaoke` และ Render `srv-dacrsvnqj5pc739fibd0` เป็นอีกระบบ ห้ามเปลี่ยน source หรือ push ไป repo นั้นเพื่อทดสอบ UI นี้

Build: `npm ci && npm test -- --maxWorkers=1 && npm run build`  
Start: `npm start`  
Health: `/api/v1/health`

ตรวจในเครื่องด้วย `npm test -- --maxWorkers=1` และ `npm run test:e2e` โดย E2E ใช้ Edge และ server ทดสอบเฉพาะ port 43180

Browser อาจให้กดเปิดเสียงบน Host ครั้งแรกก่อนเล่นวิดีโอพร้อมเสียง ห้องและคิวเก็บใน memory ของ server และจะหายเมื่อ service restart/deploy; session ที่หมดอายุต้องสแกน QR ของห้องใหม่

# Deploy KaraokeStation (Render free tier)

เอกสารนี้เป็น runbook สำหรับ preview ส่วนตัวบน Render free tier
ห้าม deploy จนกว่า CI, Cara QA และ Vera security gate จะผ่าน และยืนยันว่า API key เก่าถูก revoke แล้ว

## ทำไมต้อง Render ไม่ใช่ Netlify/Vercel

แอปนี้ต้องมี **WebSocket ที่เปิดค้างไว้** เพื่อ sync คิวแบบ realtime
Netlify/Vercel เป็น static + serverless function ที่ปิดตัวหลังจบ request
จึงถือ socket ไว้ไม่ได้ ผลคือ:

- มือถือเพิ่มเพลง → จอทีวีไม่เห็นจนกว่าจะ refresh
- ห้องหายทุกครั้งที่ function cold start

Render free tier ฟรีเหมือนกัน ไม่ต้องผูกบัตร และรองรับ WebSocket

## ขั้นตอน

### 1. push โค้ดขึ้น GitHub

Render deploy จาก Git repository เท่านั้น

```powershell
# สร้าง repo เปล่าบน github.com ก่อน (ตั้งเป็น Private ได้)
cd D:\Agents\KaraokeStation
git remote add origin https://github.com/<username>/karaoke-station.git
git push -u origin main
```

### 2. สร้าง service บน Render

1. เข้า https://render.com → Sign up ด้วย GitHub (ไม่ต้องใส่บัตร)
2. **New → Blueprint**
3. เลือก repo `karaoke-station`
4. Render จะอ่าน `render.yaml` เอง แล้วถามค่า `YOUTUBE_API_KEY`
5. **วาง API key ใหม่ตรงนี้** — ค่าถูกเก็บเป็น secret ไม่เข้า repo
6. กด **Apply**

Build จะรัน install, unit/integration test และ production build ก่อนปล่อย service
ส่วน GitHub Actions จะตรวจ hosted browser E2E เพิ่ม และ Render ตั้งให้ auto-deploy เฉพาะเมื่อ checks ผ่าน

### 3. เปิดใช้งาน

Render จะให้ URL แบบ `https://karaoke-station-xxxx.onrender.com`

- **จอคาราโอเกะ:** `<URL>/display`
- **มือถือ:** สแกน QR จากจอ

`ALLOWED_ORIGINS` ไม่ต้องตั้ง — server อ่านจาก `RENDER_EXTERNAL_URL`
ที่ Render ใส่ให้อัตโนมัติ ตั้งเองเฉพาะตอนใช้ custom domain

## สิ่งที่ต้องรู้เรื่อง free tier

| เรื่อง | พฤติกรรม |
|---|---|
| Sleep | หลับหลังไม่มี traffic 15 นาที ตื่นใช้เวลา ~1 นาที |
| ห้องหลัง restart | **หายทั้งหมด** ต้องเปิด `/display` ใหม่เพื่อสร้างห้อง+QR ใหม่ |
| Instance | 1 ตัวเท่านั้น (พอสำหรับใช้ส่วนตัว) |
| ชั่วโมง | 750 ชม./เดือน |

เปิดจอทีวีค้างไว้ระหว่างปาร์ตี้ = ไม่หลับ เพราะ WebSocket นับเป็น activity

ห้องและคิวเป็นข้อมูลชั่วคราวใน memory เท่านั้น การ restart, spin-down, deploy หรือ rollback
จะทำให้ทุกห้องหายทันที เวอร์ชันนี้จึงเหมาะกับ preview/ปาร์ตี้ส่วนตัว ไม่ใช่งานที่ต้องรับประกัน uptime

## Checklist หลัง deploy

ทดสอบบนเครื่องจริงตามลำดับนี้:

- [ ] เปิด `<URL>/display` บนโน้ตบุ๊ก Windows 7 → เห็น QR + เลขห้อง
- [ ] URL ขึ้น `https://` และไม่มี certificate warning
- [ ] มือถือสแกน QR → ใส่ชื่อ → เข้าห้องได้
- [ ] มือถือค้นหาเพลง → เจอผลลัพธ์
- [ ] กด + เพิ่มเพลง → **จอทีวีขึ้นทันทีโดยไม่ต้อง refresh**
- [ ] เพลงเล่นได้ มีเสียง
- [ ] เพลงจบ → เล่นเพลงถัดไปเองครั้งเดียว
- [ ] มือถือเครื่องที่ 2 และ 3 สแกน QR เดียวกัน → เห็นคิวตรงกันทุกเครื่อง
- [ ] กด Skip จากมือถือ → จอเปลี่ยนเพลง
- [ ] กด "สร้างห้องใหม่" → มือถือเดิมหลุด ต้องสแกนใหม่

ข้อไหนไม่ผ่าน ให้หยุดใช้งานและบันทึก URL, เวลา, browser และขั้นตอนที่ทำก่อนเกิดปัญหา

## หลัง deploy และ rollback

1. เปิด Render dashboard → service → Events แล้วตรวจว่า health check ผ่าน
2. เปิด `/api/v1/health` ต้องได้ `status: "ok"` และ `searchConfigured: true`
3. ตั้ง Render notification สำหรับ deploy failed และ service unavailable
4. ถ้า release ใหม่มีปัญหา ให้ปิด auto-deploy ชั่วคราว แล้วเลือก release ก่อนหน้าใน Events เพื่อ rollback
5. หลัง rollback ต้องสร้างห้องใหม่เสมอ เพราะ state ใน memory ไม่สามารถกู้คืนได้

ก่อนเปลี่ยน `TRUSTED_PROXY` ให้ตรวจบน preview ว่า Render ส่ง proxy chain กี่ hop
ห้ามตั้งเป็น `true`; ค่านี้รับเฉพาะจำนวน hop และค่าเริ่มต้นที่ปลอดภัยคือไม่เชื่อ proxy header

## ยังไม่ได้ทดสอบ (ต้องรอของจริง)

- Windows 7 + Chrome 109 บนเครื่องจริง — set build target ไว้แล้วแต่ไม่เคยรันบน OS นั้น
- HTTPS/WSS ผ่าน Render จริง — ที่ทดสอบมาเป็น localhost HTTP
- มือถือ 3 เครื่องพร้อมกันบนเน็ตจริง

## Security

- REST และ Socket.IO ยอมรับ browser จาก exact same origin เท่านั้น
- Socket handshake, connection, token และเนื้อเพลงมี rate/capacity limit
- API key เก่าที่เคยรั่วต้อง revoke ให้เรียบร้อยก่อนสร้าง key ใหม่
- key ใหม่ต้องจำกัดเฉพาะ YouTube Data API v3 และจำกัดตาม server IP เมื่อ provider รองรับ
- ใส่ key ใหม่ผ่าน Render secret prompt เท่านั้น ห้ามวางใน chat, `.env`, source หรือ GitHub
- `.secrets/youtube-api-key.txt` ยังมีคีย์เก่าอยู่ ควรลบหลัง rotate เสร็จ

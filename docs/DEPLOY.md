# Deploy KaraokeStation (Render free tier)

โค้ดพร้อม deploy แล้ว — commit แรกอยู่ใน git local เรียบร้อย
เหลือขั้นตอนที่ต้องใช้บัญชีของ Nut เท่านั้น

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

Build ใช้เวลาราว 3-5 นาที (`npm ci && npm run build`)

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

ข้อไหนไม่ผ่าน บอก Claude พร้อมบอกว่าติดตรงไหน

## ยังไม่ได้ทดสอบ (ต้องรอของจริง)

- Windows 7 + Chrome 109 บนเครื่องจริง — set build target ไว้แล้วแต่ไม่เคยรันบน OS นั้น
- HTTPS/WSS ผ่าน Render จริง — ที่ทดสอบมาเป็น localhost HTTP
- มือถือ 3 เครื่องพร้อมกันบนเน็ตจริง

## Security

- Vera (security auditor) ยังไม่ได้ review hosted lane นี้ — ควรทำก่อนใช้จริงจัง
- API key เก่าที่เคยรั่วต้อง revoke ให้เรียบร้อยก่อนใช้ key ใหม่
- `.secrets/youtube-api-key.txt` ยังมีคีย์เก่าอยู่ ควรลบหลัง rotate เสร็จ

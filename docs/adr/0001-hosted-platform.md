# ADR 0001 — Hosting platform สำหรับ KaraokeStation Hosted Web App

- สถานะ: **PROPOSED** — รอ Nut อนุมัติ provider และค่าใช้จ่าย
- วันที่: 2026-07-29
- บริบท: `CLAUDE_HANDOFF_HOSTED_WEB.md` เปลี่ยนทิศทางจาก Windows installer เป็นเว็บออนไลน์
  ที่โน้ตบุ๊ก Windows 7 เปิดผ่าน browser ได้ทันที

## Decision drivers

จาก handoff และข้อจำกัดจริงของงานนี้:

1. ต้อง serve frontend + REST + Socket.IO จาก **origin เดียวกัน** (ลด CORS surface,
   ทำให้ WSS ใช้ origin เดียวกับหน้าเว็บ)
2. ต้องรองรับ **WebSocket แบบ long-lived** ไม่ใช่ serverless request/response
3. ต้องมี **HTTPS/WSS พร้อม certificate ที่ Windows 7 browser เชื่อถือได้**
4. ต้องมี **secret management ฝั่ง server** สำหรับ `YOUTUBE_API_KEY`
5. ใช้งานจริงเป็นงานส่วนตัว ปาร์ตี้เป็นครั้งคราว — traffic ต่ำมาก แต่ช่วงใช้งานต้องไม่หน่วง
6. ค่าใช้จ่ายควรต่ำ และ Nut ยังไม่อนุมัติ budget

## Options considered

ราคาและนโยบายด้านล่างตรวจ ณ 2026-07-29 — ต้องตรวจซ้ำก่อน deploy จริง
เพราะทั้งสาม provider เปลี่ยนนโยบาย free tier บ่อย

### Option A — Render (Node Web Service)

| ประเด็น | ข้อมูล ณ 2026-07-29 |
|---|---|
| Free tier | มีจริง ไม่ต้องใส่บัตร; 750 instance-hours/เดือน; 512 MB RAM / 0.1 CPU |
| Sleep | **spin down หลังไม่มี traffic 15 นาที**, spin up ~30–60 วินาที |
| WebSocket | รองรับ และ WebSocket message นับเป็น activity กัน spin-down ระหว่างใช้งาน |
| Always-on | เริ่ม $7/เดือน |
| Secrets | มี environment variable / secret ใน dashboard |
| Filesystem | free tier ไม่มี persistent disk; state หายเมื่อ spin down |

**ผลกับ use case นี้:** cold start ~1 นาทีตกอยู่ที่ "เปิดจอ TV แล้วรอ" ครั้งเดียวต่อปาร์ตี้
ซึ่งพอรับได้ แต่ถ้าปล่อยจอทิ้งไว้ระหว่างพักแล้วไม่มี traffic เลย 15 นาที ห้องจะหาย
ถ้าเก็บ state ใน memory — จุดนี้แก้ได้ด้วย heartbeat จาก `/display` หรือ persistent store

### Option B — Fly.io (Machines)

| ประเด็น | ข้อมูล ณ 2026-07-29 |
|---|---|
| Free tier | **ไม่มีแล้ว** — เหลือ trial 2 VM-hours หรือ 7 วัน |
| Sleep | ตั้ง auto-stop/auto-start ได้เอง (เลือกได้ว่าจะ sleep หรือไม่) |
| WebSocket | รองรับ long-running process |
| ค่าใช้จ่ายจริง | shared-cpu-1x / 256 MB always-on ~**$1.94/เดือน**; bandwidth ฟรี 100 GB (NA/EU) |
| Secrets | `fly secrets set` — เก็บ encrypted ไม่โผล่ใน build log |

**ผลกับ use case นี้:** ถูกที่สุดสำหรับ always-on จริง ๆ และคุม sleep เองได้
แต่ไม่มี free tier แล้ว จึงต้องผูกบัตรตั้งแต่วันแรก

### Option C — Railway

| ประเด็น | ข้อมูล ณ 2026-07-29 |
|---|---|
| Free tier | $5 credit สำหรับทดลอง; Hobby $5/เดือน (รวม usage credit $5 แต่จ่ายขั้นต่ำ $5 เสมอ) |
| Sleep | ไม่ sleep — service ทำงานต่อเนื่อง |
| WebSocket | รองรับ persistent WebSocket โดยธรรมชาติ |
| ค่าใช้จ่ายจริง | usage-based; Node 0.5 vCPU/512 MB ตลอด 24 ชม. ประเมิน ~$15/เดือน — **เกิน credit** |
| Spending cap | ไม่มี hard cap ใน Hobby |

**ผลกับ use case นี้:** DX ดีและไม่ sleep แต่ usage-based ที่ไม่มี hard cap
เป็นความเสี่ยงเรื่องบิลสำหรับงานส่วนตัว

## Decision

**เสนอ Render free tier สำหรับ MVP → ย้ายไป Fly.io ถ้า Nut ยอมจ่ายรายเดือน**

เหตุผล:

- Render เป็นตัวเดียวที่เริ่มได้โดย **ไม่ผูกบัตร** จึงพิสูจน์ flow ทั้งหมด
  (Windows 7 → HTTPS → QR → มือถือ → queue realtime) ได้ก่อนตัดสินใจเรื่องเงิน
- WebSocket รองรับ และ WSS/certificate เป็นของ provider — ไม่ต้องจัดการ cert เอง
- ข้อเสียเดียวที่กระทบจริงคือ spin-down ซึ่งชนกับ requirement เรื่อง "คิวไม่หาย"
  ตรง ๆ จึงต้องออกแบบ room store ให้สลับ backend ได้ (ดู consequences)
- ถ้า Nut ยอมจ่าย Fly.io always-on ~$2/เดือนคุ้มกว่า Render always-on $7/เดือน
  และตัดปัญหา cold start ทั้งหมด

**ไม่เลือก** Vercel/Netlify/Cloudflare Pages เป็น backend เพราะ execution model
เป็น serverless/edge ที่ไม่เหมาะกับ Socket.IO แบบ long-lived stateful room
(Cloudflare ต้องเขียนใหม่เป็น Durable Objects ซึ่งเกินขอบเขต MVP)

## Consequences

**ทำให้ต้องออกแบบแบบนี้:**

1. Room store ต้องอยู่หลัง **interface** (`RoomRepository`) ให้สลับ in-memory ↔ Redis/persistent
   ได้โดยไม่แตะ domain logic — เพราะการเลือก provider ยังไม่จบ
   และ Render free tier บังคับ single instance + ไม่มี disk
2. Room มี **TTL** และ cleanup timer แทนการเก็บถาวร — ห้องคือข้อมูลชั่วคราว
3. `/display` ควรมี heartbeat/keepalive เพื่อไม่ให้ spin down กลางปาร์ตี้บน free tier
4. ห้ามพึ่ง filesystem เป็น source of truth (free tier ไม่มี persistent disk)
5. `YOUTUBE_API_KEY` มาจาก **environment เท่านั้น** ไม่มี UI ให้ตั้งค่า key อีก
   เพราะ hosted mode ไม่มี "เครื่องหลักที่เชื่อถือได้" แบบ loopback

**ความเสี่ยงที่ยังเปิดอยู่:**

- Render free tier ไม่รับประกัน uptime; ถ้าห้ามหลุดกลางงานจริงต้องขึ้น paid
- Windows 7 browser (Chrome 109 เป็น build สุดท้ายที่รองรับ) ต้องผ่าน TLS ของ provider
  — ต้องทดสอบจริงบนเครื่อง Nut ก่อนถือว่าจบ
- ยังไม่ได้ทดสอบ provider จริงเลย เพราะ credential blocker ยังไม่ปลด

## ยังต้องรอ Nut

1. ยอมรับ Render free tier (มี cold start) หรือจ่าย Fly.io/Render always-on
2. คิวต้องรอด backend restart หรือห้องชั่วคราวพอ
3. ใช้ domain เองหรือ URL ของ provider
4. ยืนยัน revoke/rotate YouTube API key เดิม (**blocker — deploy ไม่ได้จนกว่าจะเสร็จ**)

## Sources

- [Render — Free tier docs](https://render.com/docs/free)
- [Render pricing 2026 overview](https://www.srvrlss.io/provider/render/)
- [Fly.io pricing 2026 / free allowance](https://www.saaspricepulse.com/tools/flyio)
- [Fly.io pricing breakdown](https://www.runxbuild.com/blog/fly-io-pricing/)
- [Railway — Pricing plans](https://docs.railway.com/pricing/plans)
- [Railway pricing explained 2026](https://livemy.app/blog/railway-pricing)

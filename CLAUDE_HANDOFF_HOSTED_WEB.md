# KaraokeStation Hosted Web App - Claude Handoff

**วันที่:** 2026-07-29  
**ผู้ใช้:** Nut  
**โปรเจกต์:** `D:\Agents\KaraokeStation`  
**ทิศทางล่าสุด:** เปลี่ยนจากโปรแกรมติดตั้งบน Windows เป็นเว็บออนไลน์ที่เปิดผ่าน browser ได้ทันที

---

## สถานะรอบ 2026-07-29 (Claude)

Implementation Plan ข้อ 1–8 **เสร็จแล้ว** ข้อ 9–10 ยังทำไม่ได้เพราะรอ Nut

| # | งาน | สถานะ |
|---|---|---|
| 1 | ADR เปรียบเทียบ provider | ✅ `docs/adr/0001-hosted-platform.md` |
| 2 | แยก local runtime ออกจาก domain logic | ✅ `server/hosted/` แยกจาก `server/` เดิม |
| 3 | Room repository + TTL cleanup | ✅ `server/hosted/rooms.js` |
| 4 | Host/controller token model | ✅ `server/hosted/auth.js` |
| 5 | Scope REST + Socket ด้วย room | ✅ `server/hosted/app.js`, `server/hosted/index.js` |
| 6 | Frontend สร้าง/join room | ✅ `src/HostedApp.jsx`, `src/lib/hosted-api.js` |
| 7 | YouTube key เป็น env secret | ✅ ไม่มี UI ตั้ง key อีก; ไม่มี key → `503 search_unavailable` |
| 8 | Build target Chrome 109 | ✅ `vite.config.js`; ตรวจ bundle แล้วไม่มี API ใหม่กว่า |
| 9 | Deployment preview | ⏸ **รอ Nut อนุมัติ provider/ค่าใช้จ่าย** |
| 10 | QA + Security review | ⏸ **รอ deploy** |

**ผลทดสอบ:** 199/199 unit+integration ผ่าน (123 เดิม + 76 ใหม่),
hosted E2E 3/3 ผ่านบน browser จริง, legacy E2E 4/4 ยังผ่าน (ไม่มี regression)

**บั๊กที่เจอและแก้ระหว่างทาง:**
- body ใหญ่เกินคืน `500` แทน `413` เพราะ `PayloadTooLargeError` ไม่ใช่ `AppError`
- `GET /rooms/:roomId/queue` ไม่ถูกนับ rate limit (อ่านรัวได้ไม่จำกัด)

**Credential blocker ยังเปิดอยู่** — ไม่ได้แตะ `.secrets/youtube-api-key.txt` เลย
และ secret scan ยืนยันว่าไม่มี key pattern ใน source, bundle, tests หรือ config

**สิ่งที่ยังไม่ได้ทำ (ตั้งใจ):** ไม่ deploy, ไม่เรียก provider จริง, ไม่แตะ credential,
ไม่ลบ quarantine, ไม่ลบ legacy installer

---

## คำสั่งล่าสุดจาก Nut

Nut ต้องการให้ KaraokeStation ใช้งานบนโน้ตบุ๊ก Windows 7 ผ่าน browser อย่างเดียว:

- ไม่ติดตั้ง Node.js
- ไม่ติดตั้ง `KaraokeStation-Setup.exe`
- ไม่จำเป็นต้อง install PWA
- เปิด URL บนจอหลักแล้วใช้งานได้
- มือถือสแกน QR เพื่อค้นหา เพิ่ม และจัดคิวเพลง

ให้ถือ **Hosted Web App** เป็นทิศทางหลัก งาน installer เป็นงานเก่าที่พักไว้

## Start Here

1. อ่าน `D:\Agents\AGENTS.md`
2. อ่านไฟล์นี้ทั้งหมด
3. อ่าน `D:\Agents\KaraokeStation\README.md`
4. อ่านรายงาน security ก่อนแตะ credential:
   `D:\Agents\KAV.OS\output\security-auditor\2026-07-29\karaoke-station-windows7-security.md`
5. ตรวจ source ปัจจุบันใน `src`, `server`, `tests` และ `vite.config.js`
6. ห้าม deploy หรือใช้ credential จริงจนกว่า Nut จะยืนยัน provider และจัดการ key เดิม

## Product Requirements

### Display

- Route `/display` เป็นจอคาราโอเกะหลัก
- เปิด YouTube embedded player เท่านั้น ไม่ download, rip, transcode หรือ cache สื่อ
- จบเพลงแล้วเล่นเพลงถัดไปอัตโนมัติ
- แสดง toast เล็กเมื่อมีคนเพิ่มเพลง
- มี lyrics Bento drawer ด้านขวา เปิด/ปิดได้
- สร้างห้องและ QR ใหม่เมื่อเริ่ม session ใหม่

### Mobile Controller

- Route `/party`
- เข้า room ผ่าน QR โดยไม่ต้องสร้างบัญชี
- ค้นหาเฉพาะผลลัพธ์ที่เป็น:
  `karaoke`, `instrumental`, `backing track`, `คาราโอเกะ`
- แสดง local suggestions ระหว่างพิมพ์
- ทุก controller เพิ่ม, ลบ, reorder, skip และ play-now ได้
- ทุกเครื่องเห็น queue เดียวกันแบบ realtime
- stale reorder/play-now ต้องได้ revision conflict ไม่ overwrite คิวล่าสุด

### Lyrics

- คลิป Karaoke มักมีเนื้อร้องในวิดีโออยู่แล้ว
- Instrumental ให้ค้นผ่าน LRCLIB หรือ lyrics provider ที่มี API/เงื่อนไขใช้งานชัดเจน
- คง Google lyrics search เป็นลิงก์เปิดแท็บใหม่ได้
- ห้าม scrape Google search result หรือเว็บเนื้อร้องแบบไม่มีสิทธิ์

### YouTube

- ใช้ YouTube Data API v3 สำหรับ search
- API key ต้องอยู่ใน server-side environment secret เท่านั้น
- ห้ามส่ง key กลับ frontend, log, error response, artifact หรือ source
- YouTube Premium/โฆษณาขึ้นกับบัญชีที่ sign in ใน browser และนโยบาย YouTube player
  ไม่เกี่ยวกับ API key ที่ใช้ค้นหา

## Existing Implementation

Stack ปัจจุบัน:

- React 19 + Vite PWA
- Express 4
- Socket.IO
- Zod
- YouTube IFrame Player
- LRCLIB adapter
- Vitest + Playwright

ความสามารถเดิมที่ใช้ต่อได้:

- `/display` และ `/party`
- strict karaoke/instrumental/backing classification
- queue revision และ serialized mutations
- QR fragment token
- session rotation/revocation
- host/party Socket.IO snapshots
- lyrics drawer, manual lyrics, LRCLIB และ Google fallback link
- responsive UI สำหรับมือถือและ TV
- tests เดิม 123 unit/integration และ 4 browser E2E ผ่านใน build ล่าสุด

ข้อจำกัดของ architecture เดิม:

- backend bind `127.0.0.1:4173`
- Party Mode เปิด LAN listener `0.0.0.0:4174`
- state และ secrets อยู่ใน `%LOCALAPPDATA%\KaraokeStation`
- auth model อาศัย loopback เป็น host trust boundary
- API และ Socket events ยังไม่ได้ scope ด้วย online `roomId`

Hosted mode ห้ามยก trust จาก loopback/Host header เดิมไปใช้ตรง ๆ.

## Recommended Hosted Architecture

ให้คง React/Vite frontend และย้าย authoritative backend ไป cloud:

```text
Windows 7 browser /display
              |
              | HTTPS + WSS
              v
Hosted React app + API/Socket service
              |
              +-- YouTube Data API v3
              +-- LRCLIB
              +-- room store with TTL

Mobile browsers /party
```

MVP ที่เปลี่ยนน้อยที่สุด:

- deploy frontend และ Express/Socket.IO จาก origin เดียวกัน
- ใช้ managed Node service ที่รองรับ WebSocket
- ใช้ Redis หรือ durable room store หาก host อาจ restart/scale มากกว่าหนึ่ง instance
- ห้องเป็นข้อมูลชั่วคราว มี TTL เช่น 8-12 ชั่วโมง
- ไม่ต้องมี user account สำหรับ personal use
- ใช้ HTTPS/WSS เท่านั้น

อย่าเลือก hosting provider จาก assumption เรื่อง free tier ให้ตรวจราคา, sleep policy,
WebSocket support, secret management และ Windows 7 browser compatibility ณ วันที่ทำงานจริง
ก่อนเสนอ Nut.

## Required Security Redesign

สร้าง online room auth ใหม่:

- `roomId`: random public identifier
- `hostToken`: อย่างน้อย 256-bit, แสดงเฉพาะ display, เก็บใน memory/sessionStorage
- `joinToken`: อย่างน้อย 256-bit, ใส่ใน URL fragment `#join=...`
- `controllerToken`: short-lived bearer หลัง join
- ทุก API query/mutation และ Socket event ต้อง scope ด้วย `roomId`
- host-only action เช่นสร้าง/ปิด/rotate room ต้องตรวจ `hostToken`
- controller ทำได้เฉพาะ queue permissions ที่ Nut กำหนด
- rotate/close room ต้อง revoke token และ disconnect Socket เดิม
- rate-limit create room, join, search และ mutation แยกกัน
- จำกัด connection ต่อ IP, room และ bearer
- API responses ใช้ `Cache-Control: no-store`
- exact production Origin allowlist; ห้าม wildcard CORS พร้อม credential
- ปิด proxy trust โดย default หรือกำหนด trusted proxy ของ provider แบบเจาะจง
- JSON/body และ Socket payload ต้องมีขนาดสูงสุด
- log เฉพาะ metadata ห้าม log token, fragment, API key หรือ lyrics content

## Credential Blocker

Google API key เดิมเคยอยู่ที่ `release\API.txt` ก่อนถูกย้ายไป protected quarantine:

`D:\Agents\KaraokeStation\.secrets\youtube-api-key.txt`

**ห้ามเปิด, echo, validate, copy, deploy หรือพิมพ์ค่าคีย์นี้**

Security gate ปัจจุบันเป็น **BLOCK** จน Nut:

1. revoke/rotate key เดิมใน Google Cloud Console
2. ตรวจ usage/quota ของ key เดิม
3. สร้าง key ใหม่ จำกัดเฉพาะ YouTube Data API v3 และ quota ที่เหมาะสม
4. ใส่ key ใหม่ผ่าน secret manager ของ hosting provider เท่านั้น

การลบ quarantine เป็น destructive action ต้องรอคำยืนยันตรงจาก Nut.

## Legacy Installer Status

มี artifacts ที่ build แล้ว:

- Modern: `release\KaraokeStation-Setup.exe`
  - 44,571,234 bytes
  - SHA-256 `1315A8E3176F39BC58DC847DD2EA07C8E8CD6639FA8E4E1A4F44F129FD3F8AF1`
- Windows 7: `release\KaraokeStation-Windows7-Setup.exe`
  - 17,268,282 bytes
  - SHA-256 `24EDFFDE337AFA8538F7CA52F9B7099B12A87BB70D28E6F464A46A31C95F6B71`

Functional QA ผ่าน แต่ **ห้ามถือว่า release-ready**:

- Vera Security verdict ยัง BLOCK
- Windows 7, Node 12 และ browser lane เป็น EOL
- installer/launcher ไม่มี Authenticode signature
- exact legacy installer ยังไม่เคยรันบน Windows 7 hardware/VM จริง
- Nut เปลี่ยน direction ไป hosted browser-only แล้ว

เก็บไฟล์ legacy ไว้เป็น reference. ห้ามลบหรือย้อน source compatibility changes โดยไม่ตรวจ
modern regression และห้ามส่ง installer ให้ผู้ใช้เป็นทางเลือกหลัก.

## Implementation Plan

1. ทำ architecture decision record สั้น ๆ เปรียบเทียบ provider 2-3 ตัวจากข้อมูลปัจจุบัน
2. แยก local runtime assumptions ออกจาก core domain logic
3. เพิ่ม room repository interface และ TTL cleanup
4. เพิ่ม host/controller token model สำหรับ online threat boundary
5. scope REST และ Socket.IO ทั้งหมดด้วย room
6. ปรับ frontend ให้สร้าง/join room จาก hosted origin
7. ย้าย YouTube key ไป environment secret; ถ้าไม่มี key ให้แสดง setup error ที่ไม่รั่วข้อมูล
8. ตั้ง browser build target อย่างน้อย Chrome 109 และตรวจ unsupported API
9. ทำ deployment preview หลัง Nut อนุมัติ provider/ค่าใช้จ่าย
10. ให้ Cara ทำ independent QA และ Vera ทำ security review ก่อน production deploy

## Acceptance Criteria

- Windows 7 เปิด URL ด้วย browser ที่รองรับ target build โดยไม่ติดตั้ง Node/app
- display สร้าง room ใหม่และแสดง QR ได้
- มือถืออย่างน้อย 3 เครื่อง join พร้อมกันได้
- search คืนเฉพาะ Karaoke/Instrumental/Backing Track ตาม contract
- add/remove/reorder/skip/play-now sync แบบ realtime
- stale revision ได้ `409` และ UI refresh queue ถูกต้อง
- เพลงจบแล้ว advance เพียงครั้งเดียว
- close/rotate room ทำให้ token และ Socket เดิมใช้ไม่ได้
- restart/scale ของ backend ไม่ทำให้คิวหาย หากเลือก persistent room store
- API key ไม่ปรากฏใน browser bundle, network response, logs หรือ build artifacts
- HTTPS/WSS เท่านั้น ไม่มี public LAN listener
- desktop TV และมือถือไม่ล้น/ทับกัน
- ทดสอบ YouTube embed จริง, LRCLIB จริง และพฤติกรรมเมื่อ provider/quota ล้มเหลว
- unit/integration/E2E ผ่าน และมี adversarial tests สำหรับ cross-room access

## Tests To Add

- controller ของ room A อ่านหรือแก้ room B ไม่ได้
- host token ใช้เป็น controller token ไม่ได้ และกลับกัน
- guessed/expired/revoked token ถูกปฏิเสธ
- Socket cross-room subscription ถูกปฏิเสธ
- bearer หนึ่งตัวเปิด connection เกิน quota ไม่ได้
- room TTL cleanup ไม่ลบ room ที่ active
- concurrent reorder/play-now ยังคง serialized revision semantics
- Origin/CORS/proxy-header spoofing ถูกปฏิเสธ
- API responses ที่มี state/token เป็น `no-store`
- secret scan ครอบ frontend bundle, server artifact และ deployment config
- Chrome 109 compatibility smoke สำหรับ `/display` และ `/party`

## Decisions Needed From Nut

ก่อน production deployment ขอคำตอบเฉพาะเรื่อง:

1. ยอมรับ hosting รายเดือนหรือเน้น free/low-cost แม้อาจ sleep
2. ต้องการให้คิวอยู่รอดหลัง backend restart หรือเป็นห้องชั่วคราวได้
3. domain ที่จะใช้ หรือใช้ provider URL ก่อน
4. ยืนยัน rotate/revoke YouTube API key เดิม

## Definition Of Done

ยังไม่ถือว่าเสร็จเพียงเพราะ localhost หรือ preview ทำงาน. งานเสร็จเมื่อ:

- Nut อนุมัติ provider และ risk/cost
- production HTTPS URL เปิดจากโน้ตบุ๊กและมือถือจริง
- flow display -> QR -> join -> search -> queue -> playback ผ่าน
- QA PASS
- Security PASS ไม่มี blocker
- deployment/version, tests และ residual risks ถูกบันทึกใน devlog/worklog


# KaraokeStation

เว็บแอปคาราโอเกะที่เล่นวิดีโอผ่าน YouTube IFrame Player, จัดคิวร่วมกัน และให้มือถือสแกน QR
เพื่อค้นหา/ต่อคิวได้ทันที

KaraokeStation **ไม่ดาวน์โหลด, แปลง, แยกเสียง หรือ cache สื่อจาก YouTube** วิดีโอเล่นผ่าน embedded player เท่านั้น

## สองโหมดในโปรเจกต์เดียว

| โหมด | สถานะ | เอกสาร |
|---|---|---|
| **Hosted web app** (ทิศทางหลัก) | อยู่ระหว่างพัฒนา — ยังไม่ deploy | ด้านล่าง + [ADR 0001](docs/adr/0001-hosted-platform.md) |
| Local installer (Windows) | พักไว้ เป็น reference | หัวข้อ "Legacy local installer" ด้านล่าง |

---

# Hosted web app

เปิดผ่าน browser ได้ทันทีโดยไม่ต้องติดตั้ง Node.js หรือโปรแกรมใด ๆ
จอหลักเปิด `/display` แล้วสร้างห้อง + QR ให้เอง มือถือสแกน QR เข้า `/party`

## Quick start (development)

```powershell
Copy-Item .env.example .env
npm install
npm run dev:hosted
```

เปิด `http://127.0.0.1:5173` โดย Vite proxy ไปที่ hosted server ที่ port `8080`

Production build:

```powershell
npm run build
npm start
```

## Environment

| ตัวแปร | จำเป็น | ความหมาย |
|---|---|---|
| `YOUTUBE_API_KEY` | สำหรับ search | อยู่ฝั่ง server เท่านั้น ไม่เคยส่งถึง browser; ถ้าไม่ตั้ง search จะคืน `503 search_unavailable` แบบไม่บอกรายละเอียดระบบ |
| `GOOGLE_SHEETS_ID` | สำหรับ catalog | Spreadsheet ส่วนตัวที่ใช้เป็นคลังเพลงกลาง; ไม่ตั้งค่าได้และ dropdown จะว่าง |
| `GOOGLE_SHEETS_RANGE` | ไม่ (default `Catalog!A:I`) | ช่วงข้อมูลที่มีหัวคอลัมน์ `artist`, `title`, `videoId` หรือ `youtubeUrl`, `aliases` ได้ |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | เมื่อเปิด catalog | JSON service account ฝั่ง server; ใช้แทนคู่ email/private key ได้ |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | เมื่อเปิด catalog | รูปแบบแยกสำหรับ secret manager; ต้องแชร์ Sheet ให้ email นี้อ่าน/เขียนได้ |
| `GOOGLE_SHEETS_CACHE_TTL_MS` | ไม่ (default 300000) | อายุ cache ฝั่ง server; การพิมพ์ไม่เรียก Google Sheets โดยตรง |
| `PORT` | ไม่ (default 8080) | provider ส่วนใหญ่ inject ให้เอง |
| `ALLOWED_ORIGINS` | production | production origin แบบเป๊ะ คั่นด้วย comma ห้าม wildcard |
| `TRUSTED_PROXY` | ไม่ | จำนวน proxy hop ที่เชื่อถือ; ไม่ตั้ง = ไม่เชื่อ proxy header เลย (ค่าปลอดภัย) |

**ห้ามใส่ API key ลงไฟล์ใน repo** production ต้องใส่ผ่าน secret manager ของ provider

## Security model

Hosted mode ไม่มี loopback เป็น trust boundary อีกต่อไป สิทธิ์ทั้งหมดมาจาก token ที่ผูกกับห้องเดียว:

| Token | ที่อยู่ | สิทธิ์ |
|---|---|---|
| `hostToken` | 256-bit, sessionStorage ของจอหลักเท่านั้น | สร้าง/ปิด/rotate ห้อง, settings, advance เพลง, lyrics |
| `joinToken` | 256-bit, อยู่ใน URL fragment `#join=` | แลกเป็น controllerToken เท่านั้น |
| `controllerToken` | 256-bit, อายุ 12 ชม. | คิว + ควบคุมการเล่น + fair queue + อ่านประวัติ + จบเพลงปัจจุบัน |

- ทุก route และทุก Socket event scope ด้วย `roomId` — controller ห้อง A แตะห้อง B ไม่ได้
- host token ใช้เป็น controller token ไม่ได้ และกลับกัน
- `joinToken` อยู่ใน fragment จึงไม่เข้า request line, access log หรือ Referer
- rotate/close ห้อง → revoke token เดิมและ disconnect socket ทันที
- ห้องมี sliding TTL 10 ชั่วโมง และมี sweeper ลบห้องหมดอายุทุก 1 นาที
- socket จำกัด 3 connection ต่อ bearer และ 60 ต่อห้อง พร้อม expiry timer ต่อ socket
- ทุก response ของ `/api` เป็น `Cache-Control: no-store`
- CORS ใช้ allowlist แบบเป๊ะ ไม่มี wildcard และไม่มี credentialed CORS

## API contract (hosted)

Base path `/api/v1` envelope เหมือนเดิม (`{data}` / `{error:{code,message,details}}`)

| Method | Route | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `/health` | public | |
| POST | `/rooms` | public (rate-limited) | คืน `roomId`, `hostToken`, `joinToken`, `joinPath` |
| GET | `/rooms/:roomId` | host | มุมมองเต็มรวม settings/history |
| DELETE | `/rooms/:roomId` | host | ปิดห้อง + revoke ทุก token |
| POST | `/rooms/:roomId/rotate` | host | เปลี่ยน token ทั้งชุด |
| PATCH | `/rooms/:roomId/settings` | host หรือ controller | controller เปลี่ยนได้เฉพาะ `fairQueue` |
| PATCH | `/rooms/:roomId/playback` | host หรือ controller | เล่น/พัก, ระดับเสียง, mute |
| POST | `/rooms/:roomId/join` | joinToken | คืน controllerToken |
| GET | `/rooms/:roomId/queue` | host หรือ controller | |
| GET | `/rooms/:roomId/search` | host หรือ controller | strict karaoke filter |
| GET | `/rooms/:roomId/catalog/suggestions` | host หรือ controller | ค้นจาก cache ของ Google Sheet เท่านั้น; ไม่เรียก YouTube search |
| POST | `/rooms/:roomId/queue` | host หรือ controller | controller ใช้ `playNow` ไม่ได้ |
| DELETE | `/rooms/:roomId/queue/:itemId` | host หรือ controller | |
| PATCH | `/rooms/:roomId/queue/reorder` | host หรือ controller | ต้องส่ง `revision` |
| POST | `/rooms/:roomId/queue/skip` | host หรือ controller | |
| POST | `/rooms/:roomId/queue/play-now` | host หรือ controller | ต้องส่ง `revision` |
| POST | `/rooms/:roomId/queue/advance` | **host เท่านั้น** | จอหลักเรียกเมื่อเพลงจบ |
| POST | `/rooms/:roomId/queue/complete` | host หรือ controller | จบเพลงปัจจุบันและบันทึกลงประวัติ |
| POST | `/rooms/:roomId/queue/current/failure` | host | |
| GET | `/rooms/:roomId/history` | host หรือ controller | อ่านประวัติเพลงล่าสุด |
| GET/PUT | `/rooms/:roomId/lyrics/:videoId` | host | |
| GET | `/rooms/:roomId/lyrics-search` | host | LRCLIB |

Mutation ที่ขึ้นกับตำแหน่งต้องส่ง `revision` ล่าสุด; stale → `409 revision_conflict`
พร้อม `details.expectedRevision` การตรวจ revision กับ mutation อยู่ใน serialized
operation เดียวกันต่อห้อง

Controller เป็นผู้ใช้งานรีโมท จึงใช้สิทธิ์ร่วมกับ host เฉพาะการควบคุมห้องที่จำเป็นต่อการร้องเพลง:
เพิ่ม/ลบ/เรียง/ข้าม/เล่นทันทีในคิว, เล่น/พักและปรับเสียง, เปิด/ปิด fair queue,
อ่านประวัติ และกดจบเพลงปัจจุบัน. การสร้าง/ปิด/rotate ห้อง, settings อื่น,
lyrics, การรายงาน player failure และการ advance อัตโนมัติยังเป็นสิทธิ์ของ host เท่านั้น

## Socket.IO (hosted)

handshake ต้องส่งทั้งสองค่า:

```js
io({ auth: { roomId, token } });
```

Events: `room:snapshot`, `room:changed`, `room:action`, `room:presence`,
`room:revoked`, `session:expired`
Client ส่ง `room:sync` เพื่อขอ snapshot ใหม่ได้ (ใช้ตอน reconnect)

## Browser support

Build target คือ **Chrome 109** ซึ่งเป็นรุ่นสุดท้ายที่รองรับ Windows 7/8.1
(`build.target` ใน `vite.config.js`) ตรวจ bundle แล้วไม่มี API ที่ใหม่กว่านั้น

## Deployment

ยังไม่ deploy — ดู [ADR 0001](docs/adr/0001-hosted-platform.md) สำหรับการเปรียบเทียบ
provider และสิ่งที่ต้องรอ Nut ตัดสินใจ `render.yaml` เป็นข้อเสนอ ไม่ใช่ deployment ที่ใช้งานอยู่

## Tests

```powershell
npm test              # server + ui + hosted
npm run test:hosted   # hosted API + socket adversarial suite
npm run test:e2e      # Playwright
```

---

# Legacy local installer

ส่วนด้านล่างนี้เป็นของ local-first lane ที่พักไว้ ใช้ `npm run start:local`

## Requirements

- Windows 10/11 สำหรับ installer หลัก หรือ Windows 7 SP1–8.1 สำหรับ installer legacy
- Microsoft .NET Framework 4.5 หรือใหม่กว่า (installer ตรวจและหยุดพร้อมข้อความไทยถ้ายังไม่มี)
- Edge หรือ Chrome ที่รองรับระบบปฏิบัติการนั้น
- อินเทอร์เน็ตสำหรับค้นหาและเล่น YouTube
- YouTube Data API v3 key สำหรับการค้นหา (การวาง URL ยังใช้ได้หากไม่มี key)

ผู้ใช้ **ไม่ต้องติดตั้ง Node.js หรือ npm** เพราะ installer รวม official Node.js runtime ทั้ง Windows x86/x64 และ launcher เลือก architecture ให้ตรงกับระบบปฏิบัติการเอง:

- `KaraokeStation-Setup.exe`: Windows 10/11, official Node.js 22.23.1
- `KaraokeStation-Windows7-Setup.exe`: Windows 7 SP1–8.1, official Node.js 12.22.12 และ server bundle ที่ downlevel สำหรับ Node 12

Node.js 12 หมดระยะดูแลแล้ว จึงควรใช้ installer หลักบน Windows 10/11 เมื่อทำได้. Node.js 20.19+ ด้านล่างจำเป็นเฉพาะผู้พัฒนา source.

## ติดตั้งสำหรับใช้งาน

เลือกไฟล์ใน `release` ให้ตรงกับ Windows แล้วติดตั้งแบบ per-user โดยไม่ต้องใช้สิทธิ์ Administrator:

- สร้าง Start Menu และ Desktop shortcut โดย default
- เลือกเปิดพร้อม Windows เพิ่มได้
- เปิดโปรแกรมซ้ำจะสร้าง QR/session ใหม่โดยไม่ start server ซ้ำ
- installer/upgrade/uninstall หยุดเฉพาะ bundled server ที่ launcher เป็นเจ้าของ
- เพลง/คิว/settings/API key อยู่ที่ `%LOCALAPPDATA%\KaraokeStation\data` และไม่ถูกลบตอน upgrade/uninstall
- browser profile แยกอยู่ที่ `%LOCALAPPDATA%\KaraokeStation\browser`

## Development quick start

ต้องมี Node.js 20.19 ขึ้นไป:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

เปิด `http://127.0.0.1:5173` ระหว่าง development โดย Vite proxy API ไปยัง Express ที่ port `4173`

Production:

```powershell
npm run build
npm start
```

แล้วเปิด `http://127.0.0.1:4173`

ใส่ key ใน `.env` ด้วย `YOUTUBE_API_KEY=...` หรือบันทึกผ่าน `PUT /api/v1/settings/youtube-key` จากเครื่องหลัก API key อยู่ใน `secrets.json` แยกจาก state และจะไม่ถูกส่งกลับ frontend. ควรจำกัด key ใน Google Cloud Console ให้ใช้เฉพาะ YouTube Data API v3.

## Legacy source-based Windows setup

```powershell
npm run install:windows
npm run start:kiosk
npm run autostart:install
```

- `install:windows` ทำ `npm ci`, build และ backend test โดยไม่เขียนทับ `.env` ที่มีอยู่
- `start:kiosk` เปิด server แบบ hidden, รอ health check แล้วเปิด Edge/Chrome แบบ app fullscreen
- `autostart:install` สร้าง shortcut ใน Startup และจะหยุดหากมี shortcut ชื่อเดียวกันอยู่แล้ว
- ย้อนกลับด้วย `npm run autostart:uninstall`
- ข้อมูลจริงอยู่ที่ `%LOCALAPPDATA%\KaraokeStation\data` โดย default; override ได้ด้วย `DATA_DIR`

## Build installer

เครื่อง build ต้องมี npm, Windows .NET Framework C# compiler และ Inno Setup 6:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging/test-packaging.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows7-installer.ps1
```

Build หลักตรวจ SHA256 ของ official Node 22.23.1 zip/`node.exe`, ติดตั้ง backend production dependencies จาก `packaging/runtime/package-lock.json` และสร้าง `release\KaraokeStation-Setup.exe`.

Build Windows 7 ตรวจ SHA256 ของ official Node 12.22.12 zip/`node.exe`, สร้าง CommonJS server bundle ด้วย esbuild target `node12.22` โดยไม่ติดตั้ง `node_modules` บนเครื่องปลายทาง และสร้าง `release\KaraokeStation-Windows7-Setup.exe`. Installer ทั้งสองใช้ AppId เดียวกันเพื่อ upgrade ข้ามรุ่นได้ แต่ compile launcher ให้เลือก server entry ของ lane ตัวเองเท่านั้นและลบเฉพาะ stale entry ของอีก lane ระหว่าง upgrade; user data ไม่ถูกลบ. OS gate ป้องกันการติดตั้ง runtime ผิดรุ่น และ prerequisite gate ตรวจ .NET Framework 4.5+ โดยไม่ดาวน์โหลดหรือติดตั้ง dependency เงียบ ๆ. Node binaries ต้องมี Authenticode `Valid`; launcher/installer ที่ build local ยังเป็น `NotSigned` หากไม่มี code-signing certificate.

## Runtime boundary

- Host server bind เฉพาะ `127.0.0.1:4173`
- เมื่อ Host เปิด Party Mode เท่านั้น จึงสร้าง LAN listener ที่ `0.0.0.0:4174`
- เมื่อปิด Party Mode LAN listener จะปิดและ guest sessions ทั้งหมดถูก revoke
- privileged endpoints ตรวจ `request.socket.remoteAddress` และยอมรับเฉพาะ loopback; header เช่น `X-Forwarded-For` ไม่เพิ่มสิทธิ์
- Party Mode ใช้ HTTP ภายใน home Wi-Fi; PIN ไม่ป้องกันผู้ดักฟังบนเครือข่ายที่ไม่น่าเชื่อถือ

## API contract

Base path คือ `/api/v1`. Success ใช้ envelope:

```json
{ "data": {} }
```

Failure:

```json
{
  "error": {
    "code": "validation_error",
    "message": "ข้อมูลที่ส่งมาไม่ถูกต้อง",
    "details": []
  }
}
```

ทุก `POST`, `PUT`, `PATCH`, `DELETE` ต้องส่ง `Content-Type: application/json`. เมื่อ browser ส่ง `Origin` ค่า host ต้องตรงกับ request `Host`.

### Public / Party read

| Method | Route | Response `data` |
|---|---|---|
| GET | `/health` | `{status, version, uptimeSeconds, timestamp}` |
| GET | `/party/status` | `{enabled, stationName, revision, current, next}` โดย `next` คือ waiting queue ครบสูงสุด 100 เพลง |
| POST | `/party/join` | `{displayName,pin}` หรือ `{displayName,joinToken}` → `{token,displayName,expiresAt,sessionId}` |

### Host-only state and config

| Method | Route | Contract |
|---|---|---|
| GET | `/config` | `{version, settings, youtube:{configured,key:null}, party:{enabled,pinExpiresAt}}` |
| GET | `/state` | authoritative `{revision, settings, current, queue, favorites, history, lyrics}` |
| GET/PATCH | `/settings` | PATCH accepts supported setting fields only |
| PUT | `/settings/youtube-key` | body `{youtubeApiKey}`; response never contains the key |

Settings fields: `stationName`, `language`, `theme`, `autoplayNext`, `confirmPlayNow`, `defaultVolume`, `defaultLyricsMode`, `singleKeyShortcuts`, `allowDuplicate`, `partyEnabled`, `guestRateLimitPerMinute`, `lrclibEnabled`.

### YouTube

| Method | Route | Contract |
|---|---|---|
| POST | `/youtube/parse` | body `{input}` → `{videoId, canonicalUrl}`; supports video ID, watch, youtu.be, shorts, live, embed HTTPS URLs |
| GET | `/search?q=...&mode=both&limit=12` | `mode`: `both`, `karaoke`, `instrumental`, `backing`, `none`; result `{query,mode,results,cached}` |
| GET | `/suggestions?q=...&limit=8` | แนะนำจากคำค้นล่าสุด/คิว/รายการโปรด/ประวัติในเครื่องเท่านั้น |

`both` เป็นค่า default และส่งคำค้นไป official YouTube API ครั้งเดียวต่อ submit จากนั้นกรองแบบ strict ว่าชื่อหรือ description ต้องมี `karaoke`, `instrumental`, `backing track` หรือ `คาราโอเกะ`. Search ใช้ `search.list` พร้อม `type=video`, `videoEmbeddable=true`, `videoSyndicated=true`, แล้วตรวจ `videos.list` อีกครั้ง. Cache ใน memory 24 ชั่วโมง สูงสุด 200 queries รวมผลว่าง; suggestions ไม่เรียก YouTube. Upstream timeout 8 วินาที.

Search result:

```json
{
  "videoId": "dQw4w9WgXcQ",
  "title": "Song title",
  "channelTitle": "Channel",
  "thumbnailUrl": "https://i.ytimg.com/...",
  "duration": "PT4M12S",
  "classification": "karaoke",
  "badge": "Karaoke",
  "embeddable": true,
  "canonicalUrl": "https://www.youtube.com/watch?v=..."
}
```

### Queue

Track input:

```json
{
  "videoId": "11-char-id",
  "title": "required",
  "channelTitle": "",
  "thumbnailUrl": "https://i.ytimg.com/...",
  "duration": "PT4M12S",
  "classification": "karaoke",
  "badge": "Karaoke"
}
```

`classification`/`badge` ต้องเป็นคู่ที่ตรงกัน: `karaoke`/`Karaoke`, `instrumental`/`Instrumental` หรือ `backing_track`/`Backing Track`. ข้อมูลเก่าจะ migrate เป็น schema v2 โดยเติมทั้งสอง field เป็น `null`.

| Method | Route | Contract |
|---|---|---|
| GET | `/queue` | `{revision,current,items}` |
| POST | `/queue` | `{track,playNow?,allowDuplicate?}` → item + queue |
| PATCH | `/queue/reorder` | `{itemId,toIndex}`; `toIndex` นับเฉพาะ waiting queue จาก 0 |
| DELETE | `/queue/:itemId` | ลบ waiting item; หากเป็น current จะ advance |
| DELETE | `/queue` | ล้าง current + queue |
| POST | `/queue/advance` | body `{}`; current เข้า history และดึงเพลงถัดไป |
| POST | `/queue/current/failure` | `{reason,message?}`; reason: `embed_disabled`, `private`, `region_restricted`, `player_error`, `network` |

คิวมี current แยกจาก waiting `items`, สูงสุด 100 waiting items. ทุก mutation เพิ่ม `revision` และเขียน state แบบ serialized atomic write.

### Favorites, history, lyrics

| Method | Route | Contract |
|---|---|---|
| GET/POST | `/favorites` | POST ใช้ Track input |
| DELETE | `/favorites/:videoId` | ลบรายการโปรด |
| GET | `/history?limit=100` | สูงสุด 1,000 |
| DELETE | `/history` | ล้างประวัติ |
| GET | `/lyrics/:videoId` | `{revision,item}`; item เป็น `null` หากยังไม่มี |
| PUT | `/lyrics/:videoId` | `{kind:"plain\|lrc",content,source:"manual\|lrclib",trackName?,artistName?}` |
| DELETE | `/lyrics/:videoId` | ลบเนื้อร้องที่บันทึก |
| GET | `/lyrics-search?track=...&artist=...&album=...` | ใช้ได้เมื่อ `lrclibEnabled=true`; timeout 6 วินาที |

Manual lyrics สูงสุด 100 KB ต่อเพลง. LRCLIB เป็น optional adapter และปิดโดย default; ไม่มีการ scrape เว็บไซต์.

### Party host control

| Method | Route | Contract |
|---|---|---|
| GET | `/party` | `{enabled,sessionId,pin,pinExpiresAt,joinPath,urls}`; host-only |
| POST | `/party/session/start` | body `{}` → เปิด listener และสร้าง launch session/PIN ใหม่เสมอ |
| POST | `/party/rotate` | compatibility alias สำหรับ rotate session ที่เปิดอยู่ |

ทุก process start สร้าง PIN และ CSPRNG launch token ใหม่. `joinPath`/`urls` ใช้ `/party#join=<token>` เพื่อไม่ให้ token เข้า HTTP request หรือ access log. การ start/rotate/restart revoke join token และ bearer token เดิมทันที; PIN เป็น fallback.

### Party controller

หลัง `/party/join` ให้ส่ง `Authorization: Bearer <token>`.

| Method | Route | Contract |
|---|---|---|
| GET | `/party/search?q=...&mode=both&limit=...` | contract เหมือน Host search |
| GET | `/party/suggestions?q=...&limit=8` | local suggestions; ไม่เรียก YouTube |
| POST | `/party/queue` | `{track,allowDuplicate?}` |
| DELETE | `/party/queue/:itemId` | `{revision}`; ลบเพลงรอหรือเพลงปัจจุบัน |
| PATCH | `/party/queue/reorder` | `{itemId,toIndex,revision}`; ย้ายได้เฉพาะเพลงรอ |
| POST | `/party/queue/skip` | `{revision}` |
| POST | `/party/queue/play-now` | `{itemId,revision}`; เลือกเพลงรอมาเล่นทันที |

ทุก controller มีสิทธิ์เท่ากันสำหรับคิว. Mutation ที่ขึ้นกับตำแหน่งต้องส่ง revision ล่าสุด; stale request ได้ `409 revision_conflict` พร้อม `details.expectedRevision`. การตรวจ revision และ mutation อยู่ใน serialized repository operation เดียวกัน. Controller ไม่มีสิทธิ์เข้าถึง settings, API key, favorites, history หรือ lyrics. Rate limit default 10 action requests ต่อนาทีต่อ session และมี in-memory session cap 100 controller.

## Socket.IO

Path default `/socket.io`.

Host connection ผ่าน loopback:

- server → `state:snapshot`
- server → `queue:changed`
- server → `library:changed`
- server → `settings:changed`

Party connection ส่ง token จาก join:

```js
io({ auth: { token } });
```

Events:

- server → `party:snapshot` (current + waiting queue ครบสูงสุด 100, ไม่มี settings/secrets/library)
- server → `party:changed`
- server → `party:action` (`{actor,action,track,revision,timestamp}` สำหรับ TV toast)
- server → `guest:count`

REST เป็น mutation contract หลัก; Socket.IO ใช้ authoritative snapshot/reconnect notification เพื่อลด duplicate command.

## Persistence

`state.json` เก็บ settings, current/queue, favorites, history และ lyrics. `secrets.json` เก็บ API key/PIN แยกต่างหาก. การเขียนใช้ temp file → backup → atomic rename และ serialized mutation queue. หาก `state.json` เสีย จะลองอ่าน `.bak`; หากทั้งคู่เสีย server จะหยุดแทนการเขียนทับข้อมูลเงียบ ๆ.

## Tests

```powershell
npm run test:server
npm test
npm run test:e2e
```

Backend suite ครอบคลุม URL validation, official YouTube filters/cache/quota mapping, atomic writes/backup recovery, Thai Unicode, queue/history/favorites/lyrics, Party PIN/revoke, secret non-disclosure, Origin restriction, CSP และ Referrer-Policy.

# KaraokeStation — Design Preview

เปิด `index.html` ด้วยการดับเบิลคลิก แล้วเลือก `host.html`, `mobile.html` หรือ sandbox ตรวจ Hosted contract ไม่ต้องติดตั้งแพ็กเกจหรือเปิด server

## ลองใช้งาน

1. เปิด Host และ Mobile เป็นสองแท็บใน Chrome เดียวกัน
2. ใส่ชื่อเข้าห้องตัวอย่างบน Mobile แล้วค้นหา/เพิ่มเพลงจากรายการตัวอย่าง
3. แตะชื่อเพลงหรือปุ่มลูกศรที่แถบเพลงด้านล่าง เพื่อเปิดรีโมท: เล่น/พัก ข้ามเพลง ระดับเสียง mute และจบเพลงตัวอย่าง
4. แท็บคิวมีเล่นทันที ย้ายขึ้น/ลง ลบ และผลัดกันร้อง ประวัติจะเปลี่ยนตามสิ่งที่ทำและกดร้องอีกได้
5. ปุ่มตั้งค่าที่มุมบนใช้เปลี่ยนชื่อและสร้างห้องตัวอย่างใหม่หลังยืนยัน ปุ่มแชร์เปิดแผงคัดลอกข้อความตัวอย่าง ไม่ส่งข้อความออกไป

Host เป็นจอแสดงผลอย่างเดียว: ภาพเวทีเต็มพื้นที่แบบรักษาสัดส่วน มี QR/ข้อมูลห้องตัวอย่างมุมบนและเพลงถัดไปมุมล่าง ปุ่ม fullscreen ซ่อนหลัง idle 2.5 วินาที เรียกกลับด้วยเมาส์ การแตะ หรือคีย์บอร์ด

อ่านการเทียบกับแอปเดิมและสิ่งที่ยังไม่ได้เชื่อมจริงที่ [FEATURE-PARITY.md](FEATURE-PARITY.md)

## ลองกับ KaraokeStation จริงแบบแยก

เปิด [karaoke-station-test/contract-fixture.html](karaoke-station-test/contract-fixture.html) เพื่อดู shape ของข้อมูลและตรวจ `health`, `queue`, `history` ของ Hosted server แบบอ่านอย่างเดียว หน้า fixture ไม่เรียกเครือข่ายจนกว่าจะกรอก loopback URL และ token เอง รายละเอียดและคำสั่งอยู่ใน [karaoke-station-test/README.md](karaoke-station-test/README.md)

## ข้อจำกัด

- เป็นข้อมูลจำลอง ไม่มีเสียง/วิดีโอ YouTube จริง QR สแกนเข้าห้องจริงไม่ได้
- ซิงก์เฉพาะแท็บใน browser เดียวกันผ่าน localStorage/BroadcastChannel โดยทดสอบ file:// บน Chrome; ไม่ใช่การซิงก์มือถือจริงกับทีวี
- การค้นหาใช้ชุดเพลงตัวอย่าง ส่วน URL ที่ไม่รู้จักจะแจ้งว่าไม่เชื่อม YouTube; `youtu.be/after-hours-demo` ใช้ลอง flow ตัวอย่างได้โดยไม่ส่งเครือข่าย
- storage ที่ถูกปิดใช้ memory ชั่วคราวแทน การทำงานหลายคนพร้อมกันยังไม่ใช่ server revision/conflict handling ของแอปจริง
- ภาพ `assets/kavaoke-family-home.png` สร้างด้วย built-in imagegen มีบันทึก prompt ใน `assets/IMAGE-NOTE.md`
- source แอปจริงใน `src/` และ `server/` ไม่ได้เปลี่ยนในงานนี้

## การตรวจ

`qa/feature-parity-smoke.mjs` เป็นการตรวจพฤติกรรมรอบนี้ (ต้องใช้ Node, package ของโปรเจกต์ และ Chrome ที่ติดตั้งไว้):

```powershell
node design-preview/qa/feature-parity-smoke.mjs
```

ผลและภาพล่าสุดอยู่ใน `qa/feature-parity-results.json`, `qa/integration-sandbox-qa.md`, `qa/mobile-parity-search.png`, `qa/mobile-parity-remote.png`, `qa/host-parity-idle.png`

ไฟล์ `qa-preview.mjs` และ `host-display-qa.mjs` เป็นหลักฐานจากดีไซน์รอบก่อน มีสมมติฐานและ hash เก่า ไม่ใช่ acceptance suite ของพรีวิวรอบนี้

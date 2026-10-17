# LH Session Sync — Chrome Extension

ปุ่มเดียว sync คุกกี้ `_littlehotelier_session` จาก `apac.littlehotelier.com` เข้า
`lh-rate-automation` (Apps Script) โดยตรง ไม่ต้องเปิด DevTools/copy-paste เอง

## วิธีติดตั้ง

1. เปิด Chrome → `chrome://extensions` → เปิด **Developer mode**
2. กด **Load unpacked** → เลือกโฟลเดอร์นี้ (`extension/`)

## Backend ที่ใช้คู่กัน

- Apps Script: `src/SessionSync.gs` (deploy เป็น Web App, `doPost()`)
- ต้องตั้ง Script Property `SESSION_SYNC_TOKEN` ให้ตรงกับ `SYNC_TOKEN` ใน `popup.js`
- `WEB_APP_URL` ใน `popup.js` ต้องตรงกับ URL ของ Web App deployment (ลงท้าย `/exec`)

## วิธีใช้งาน (ตอน session หมดอายุ)

1. Login เข้า `apac.littlehotelier.com` ให้ผ่าน MFA ตามปกติ
2. กดไอคอน extension → กด **"Sync LH Session"**
3. ขึ้น `✅ Sync สำเร็จ!` แปลว่า `LH_SESSION_COOKIE` + `LH_SESSION_SET_AT` ถูกอัปเดตใน
   Script Properties ให้แล้วอัตโนมัติ

## หมายเหตุด้านความปลอดภัย

`popup.js` มี `SYNC_TOKEN` ฝังอยู่ในโค้ด (จำเป็น เพราะเป็น client-side extension) —
repo นี้เป็น private repo อยู่แล้ว แต่ถ้าจะแชร์โค้ดนี้ต่อที่อื่นต้องเปลี่ยน token ใหม่ก่อน


## Auto-sync (v1.1)

`background.js` (service worker) ดักคุกกี้ `_littlehotelier_session` — พอ login+MFA เสร็จและค่านิ่ง ~30 วินาที
จะเช็คว่าล็อกอินจริง (เปิดหน้า inventory แล้วเจอ `rate_plan_dates`) แล้วส่งเข้า Apps Script เอง ไม่ต้องกดปุ่ม

- หลังแก้โค้ด ต้อง reload extension ที่ `chrome://extensions` หนึ่งครั้ง
- ต้องเปิดเบราว์เซอร์ไว้ตอน login; ไอคอนขึ้น ✓ เขียว = sync สำเร็จ, ! แดง = ล้มเหลว (ดูเหตุผลใน
  `chrome.storage.local` key `lastAutoSync` ผ่าน service worker console)
- ไม่ sync ซ้ำตาม timer (กัน keep-alive ฝั่ง Apps Script โดนค่าเก่าทับ) และไม่สั่ง push อัตโนมัติ —
  ถ้า login หลังรอบ 22:30 ให้กดปุ่ม "Sync + Push Rate" ใน popup
- ค่าตั้งต้น (URL/token) ย้ายมาอยู่ใน `config.js`
- LH session ยังหมดที่ ~4 ชม. หลัง login (ข้อจำกัดฝั่ง LH) — ควร login หลัง ~19:00
- ถ้าหน้า login/MFA ของ LH มีตัวเลือก "จำอุปกรณ์นี้" ให้ติ๊ก เพื่อลดขั้น login รายวัน

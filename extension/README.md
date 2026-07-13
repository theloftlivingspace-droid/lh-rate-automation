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

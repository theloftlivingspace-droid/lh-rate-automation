// ค่าตั้งต้นที่ใช้ร่วมกันระหว่าง popup.js (ปุ่ม) กับ background.js (auto-sync)
// WEB_APP_URL / SYNC_TOKEN: ดูคำอธิบายใน README.md (Apps Script Web App + Script Property SESSION_SYNC_TOKEN)
// REMOTE_TRIGGER_TOKEN: ใช้เฉพาะปุ่ม "Sync + Push Rate" ใน popup (background ไม่ได้สั่ง push)
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbx_z1v7FEqmthTKfZPoLsyqdIc4NJENXpfsZ315dDLzdIHwznSsOQqnG1UxkyqhOCk/exec";
const SYNC_TOKEN = "KTxEAEYfhxYqlbVrKp-t00BkNSdqJ8iv92gO-3l8ut0";
const REMOTE_TRIGGER_TOKEN = "Lft6801-rXk9pQ2vN7mZs4Tw8Ye3Jc5Hb1Fg0Dq";

// ใช้เช็คว่าคุกกี้ในเบราว์เซอร์ "ล็อกอินอยู่จริง" ก่อน auto-sync (ต้องตรงกับ LHRateAutomation.gs / LHSession.gs)
const LH_ORIGIN = "https://apac.littlehotelier.com";
const LH_PROPERTY_ID = "14501";
const LH_COOKIE_NAME = "_littlehotelier_session";
const LH_AUTH_MARKER = "rate_plan_dates";

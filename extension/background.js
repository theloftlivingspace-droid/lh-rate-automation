// LH Session Sync — auto-sync ใน background (Manifest V3 service worker)
//
// เมื่อคุกกี้ _littlehotelier_session ในเบราว์เซอร์เปลี่ยน (เช่น หลัง login+MFA) จะรอให้ค่านิ่ง ~30 วินาที
// แล้วเช็คว่า "ล็อกอินอยู่จริง" (เปิดหน้า inventory แล้วเจอ marker) ก่อนค่อยส่งเข้า Apps Script
// — ไม่ส่งคุกกี้ guest/หน้า login ไปทับ session ดีฝั่ง Apps Script
// ไม่มี timer sync ซ้ำ: keep-alive ฝั่ง Apps Script หมุนคุกกี้เองอยู่แล้ว ไม่เอาค่าเก่าไปทับ
// ไม่สั่ง compute/push อัตโนมัติ (กันรันซ้อนกับ trigger กลางคืน) — ถ้าจะ push ทันทีให้กดปุ่มใน popup

importScripts("config.js");

const SYNC_ALARM = "lh-auto-sync";
const SETTLE_MINUTES = 0.5; // ขั้นต่ำของ chrome.alarms
const SELF_CHANGE_GUARD_MS = 15000; // ไม่นับ cookie change ที่เกิดจากการเช็ค/ sync ของเราเอง

let busyUntil = 0;

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function record(status) {
  await chrome.storage.local.set({ lastAutoSync: { at: new Date().toISOString(), ...status } });
}

chrome.cookies.onChanged.addListener((change) => {
  const c = change.cookie;
  if (c.name !== LH_COOKIE_NAME || !c.domain.endsWith("littlehotelier.com")) return;
  if (change.removed && change.cause !== "overwrite") return; // logout/หมดอายุ: ไม่ต้องทำอะไร
  if (change.removed) return; // overwrite = เหตุการณ์คู่กับ set ที่ตามมา
  if (Date.now() < busyUntil) return;
  chrome.alarms.create(SYNC_ALARM, { delayInMinutes: SETTLE_MINUTES }); // สร้างซ้ำ = รีเซ็ตเวลารอ
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) return autoSync();
});

async function isLoggedIn() {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" });
  const url = `${LH_ORIGIN}/extranet/properties/${LH_PROPERTY_ID}/inventory/edit?start_date=${today}&viewable_fields=detailed`;
  const resp = await fetch(url, { credentials: "include", redirect: "follow" });
  if (resp.status === 429 || resp.status >= 500) return "transient";
  if (resp.status === 200 && (await resp.text()).includes(LH_AUTH_MARKER)) return "yes";
  return "no";
}

async function autoSync() {
  busyUntil = Date.now() + SELF_CHANGE_GUARD_MS;
  try {
    const state = await isLoggedIn(); // การเช็คนี้อาจทำให้ LH หมุนคุกกี้ → อ่านค่าหลังเช็คเสมอ
    busyUntil = Date.now() + SELF_CHANGE_GUARD_MS;
    if (state === "no") { await record({ ok: false, reason: "not-logged-in" }); return; }
    if (state === "transient") { await record({ ok: false, reason: "transient" }); return; }

    const cookie = await chrome.cookies.get({ url: LH_ORIGIN, name: LH_COOKIE_NAME });
    if (!cookie || cookie.value.length < 20) { await record({ ok: false, reason: "no-cookie" }); return; }

    const { lastSyncedValue } = await chrome.storage.local.get("lastSyncedValue");
    if (lastSyncedValue === cookie.value) return; // ค่าเดิมที่ sync ไปแล้ว

    const resp = await fetch(WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ token: SYNC_TOKEN, cookie: cookie.value }),
    });
    const data = await resp.json();
    busyUntil = Date.now() + SELF_CHANGE_GUARD_MS;
    if (!data.ok) { await record({ ok: false, reason: "server:" + (data.error || "unknown") }); badge("!", "#C0392B"); return; }

    await chrome.storage.local.set({ lastSyncedValue: cookie.value });
    await record({ ok: true });
    badge("✓", "#2E8B57");
    setTimeout(() => badge(""), 60 * 60 * 1000);
  } catch (err) {
    await record({ ok: false, reason: "error:" + err.message });
    badge("!", "#C0392B");
  }
}

/**
 * LHSession.gs
 * ---------------------------------------------------------
 * ดูแลอายุ session ของ Little Hotelier (_littlehotelier_session)
 *
 * ปัญหาเดิม: LH_SESSION_COOKIE ถูก sync มือหลัง login+MFA แล้วใช้ค่าเดิมซ้ำทุก request
 * โดยไม่เคยเก็บคุกกี้ใหม่ที่ LH ส่งกลับมา (Set-Cookie) และไม่มีอะไรเรียก LH ระหว่างวัน
 * (push รันคืนละครั้ง ~02:20) → session หมดก่อนรอบถัดไป และ "ตอบผิดปกติชั่วคราว"
 * ก็ถูกรายงานเป็น "session หมดอายุ" ด้วย
 *
 * สิ่งที่ไฟล์นี้ทำ:
 *  1. lhFetch_()  — ทุก request ไป LH ใช้คุกกี้ล่าสุดใน Script Properties และ
 *     ถ้า LH ออกคุกกี้ใหม่มาในหน้าที่ล็อกอินอยู่จริง (200 + มี rate_plan_dates) จะเก็บทับให้เอง
 *     (ไม่เก็บจาก response ที่เป็นหน้า login/ผิดปกติ — กันเอาคุกกี้ guest ไปทับของดี)
 *  2. checkSessionState_() — แยก 'valid' | 'expired' | 'transient' (429/5xx/network) + ลองซ้ำ
 *  3. keepLhSessionAlive() — trigger ทุก 30 นาที เรียก LH เบาๆ เพื่อต่ออายุ + แจ้ง "หมดอายุจริง"
 *     ครั้งเดียวต่อรอบ sync (ไม่แจ้งช่วง 22:00-07:00)
 *
 * ตั้ง trigger ครั้งเดียว: รัน setupKeepAliveTrigger()
 * Script Properties ที่เพิ่ม (อ่านเพื่อวินิจฉัยได้):
 *   LH_SESSION_REFRESHED_AT / LH_SESSION_ROTATIONS — คุกกี้ถูกต่ออายุอัตโนมัติล่าสุดเมื่อไร / กี่ครั้ง
 *   LH_SESSION_LAST_OK_AT — keep-alive สำเร็จล่าสุด
 *   LH_SESSION_EXPIRED_AT — แจ้งหมดอายุล่าสุด (รีเซ็ตเองเมื่อ sync คุกกี้ใหม่)
 * ---------------------------------------------------------
 */

const LH_COOKIE_NAME = '_littlehotelier_session';
const LH_AUTH_MARKER = 'rate_plan_dates'; // มีเฉพาะหน้า inventory ที่ล็อกอินอยู่
const LH_QUIET_HOURS = { from: 22, to: 7 }; // ไม่แจ้ง "หมดอายุ" จาก keep-alive ช่วงนี้ (Bangkok)

// fetch ไป LH ด้วยคุกกี้ล่าสุด + เก็บคุกกี้ใหม่ถ้า LH หมุนค่าให้
function lhFetch_(url, opts) {
  opts = Object.assign({}, opts || {});
  opts.headers = Object.assign({}, opts.headers || {});
  const current = PropertiesService.getScriptProperties().getProperty('LH_SESSION_COOKIE');
  if (current) opts.headers.Cookie = LH_COOKIE_NAME + '=' + current;
  const resp = UrlFetchApp.fetch(url, opts);
  try {
    lhMaybeRotateCookie_(resp, current, String(opts.method || 'get').toLowerCase());
  } catch (e) {
    Logger.log('lhMaybeRotateCookie_ error (ไม่กระทบ request): ' + e);
  }
  return resp;
}

function lhExtractSessionCookie_(resp) {
  const headers = resp.getAllHeaders() || {};
  let sc = headers['Set-Cookie'] || headers['set-cookie'];
  if (!sc) return null;
  if (Array.isArray(sc)) sc = sc.join('\n');
  const m = String(sc).match(new RegExp('(?:^|[\\s,;])' + LH_COOKIE_NAME + '=([^;,\\s]*)'));
  return m && m[1] && m[1].length >= 20 ? m[1] : null; // สั้น/ว่าง = คุกกี้ถูกลบ ไม่ใช่ค่าใหม่
}

function lhMaybeRotateCookie_(resp, current, method) {
  if (method !== 'get' || resp.getResponseCode() !== 200) return false;
  if (resp.getContentText().indexOf(LH_AUTH_MARKER) === -1) return false; // ไม่ใช่หน้าที่ล็อกอินอยู่ → ห้ามเก็บ
  const fresh = lhExtractSessionCookie_(resp);
  if (!fresh || fresh === current) return false;
  const props = PropertiesService.getScriptProperties();
  props.setProperty('LH_SESSION_COOKIE', fresh);
  props.setProperty('LH_SESSION_REFRESHED_AT', new Date().toISOString());
  props.setProperty('LH_SESSION_ROTATIONS', String((parseInt(props.getProperty('LH_SESSION_ROTATIONS'), 10) || 0) + 1));
  Logger.log('🔄 LH ออกคุกกี้ session ใหม่ — เก็บทับให้อัตโนมัติแล้ว');
  return true;
}

function classifyLhResponse_(resp) {
  const code = resp.getResponseCode();
  if (code === 429 || code >= 500) return 'transient';
  if (code === 200 && resp.getContentText().indexOf(LH_AUTH_MARKER) !== -1) return 'valid';
  return 'expired'; // redirect ไป login / 401 / 403 / หน้าไม่มีข้อมูลล็อกอิน
}

// 'valid' | 'expired' | 'transient' — ลองซ้ำ transient สูงสุด 3 ครั้งก่อนยอมรับ
function checkSessionState_() {
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const url = `${LH_BASE_URL}/extranet/properties/${LH_PROPERTY_ID}/inventory/edit?start_date=${todayStr}&viewable_fields=detailed`;
  let state = 'transient';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      state = classifyLhResponse_(lhFetch_(url, { method: 'get', muteHttpExceptions: true }));
    } catch (e) {
      Logger.log('checkSessionState_ network error (ครั้งที่ ' + attempt + '): ' + e);
      state = 'transient';
    }
    if (state !== 'transient') return state;
    if (attempt < 3) Utilities.sleep(attempt * 5000);
  }
  return state;
}

function lhBangkokHour_() {
  return parseInt(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'H'), 10);
}
function lhIsQuietHour_() {
  const h = lhBangkokHour_();
  return h >= LH_QUIET_HOURS.from || h < LH_QUIET_HOURS.to;
}

// trigger ทุก 30 นาที — ต่ออายุ session และแจ้งเมื่อหมดอายุจริง
function keepLhSessionAlive() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('⏭️ keepLhSessionAlive ข้าม — มีงาน push/diff กำลังรันอยู่ (ตัวนั้นใช้ session อยู่แล้ว)');
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty('LH_SESSION_COOKIE')) {
      Logger.log('keepLhSessionAlive: ยังไม่มี LH_SESSION_COOKIE');
      return;
    }
    const setAt = props.getProperty('LH_SESSION_SET_AT') || '';
    const expiredAt = props.getProperty('LH_SESSION_EXPIRED_AT') || '';
    if (expiredAt && (!setAt || setAt <= expiredAt)) {
      Logger.log('keepLhSessionAlive: แจ้งหมดอายุไปแล้ว รอ sync คุกกี้ใหม่ — ข้าม');
      return;
    }
    const state = checkSessionState_();
    if (state === 'valid') {
      props.setProperty('LH_SESSION_LAST_OK_AT', new Date().toISOString());
      Logger.log('✅ keepLhSessionAlive: session ยังใช้ได้');
      lhMaybeSyncGuests_(); // เติมจำนวนแขกจากหน้า Reservations ของ LH (ทุก ~2 ชม. / ดู LHGuests.gs)
    } else if (state === 'transient') {
      Logger.log('⚠️ keepLhSessionAlive: LH ตอบผิดปกติชั่วคราว (429/5xx/network) — ยังไม่ตัดสินว่าหมดอายุ รอรอบหน้า');
    } else if (lhIsQuietHour_()) {
      Logger.log('😴 keepLhSessionAlive: session หมดอายุ แต่อยู่ในช่วงเงียบ (22:00-07:00) — จะแจ้งตอนเช้า');
    } else {
      props.setProperty('LH_SESSION_EXPIRED_AT', new Date().toISOString());
      Logger.log('❌ keepLhSessionAlive: session หมดอายุจริง — แจ้งแอดมิน');
      notifySessionExpired(getSessionAgeStr_());
    }
  } finally {
    lock.releaseLock();
  }
}

// รันครั้งเดียวเพื่อตั้ง trigger ต่ออายุ session ทุก 30 นาที
function setupKeepAliveTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'keepLhSessionAlive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('keepLhSessionAlive').timeBased().everyMinutes(30).create();
  Logger.log('ตั้ง trigger เรียบร้อย: keepLhSessionAlive ทุก 30 นาที');
}

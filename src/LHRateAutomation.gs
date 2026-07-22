/**
 * LHRateAutomation.gs
 * ---------------------------------------------------------
 * (CI test: base64 credentials fix verification)
 * อ่านราคาจาก sheet "Target_Rates" (เขียนโดย computeTargetRates.gs)
 * แล้วโพสต์เข้า Little Hotelier ผ่าน session cookie (ไม่มี public API)
 *
 * ก่อนใช้งาน — ตั้งค่า Script Properties (Project Settings > Script Properties):
 *   LH_SESSION_COOKIE = ค่า cookie "_littlehotelier_session" ล่าสุด
 *     (ดึงจาก Safari/Chrome DevTools > Storage/Application > Cookies
 *      หลัง login + ผ่าน MFA ที่ apac.littlehotelier.com)
 *
 * ⚠️ DRY_RUN = true ตอนแรก — จะ log ว่าจะเปลี่ยนอะไรบ้าง แต่ไม่ POST จริง
 *    ทดสอบดู log ให้ชัวร์ก่อน แล้วค่อยเปลี่ยนเป็น false
 * ---------------------------------------------------------
 */

const LH_SHEET_ID = '1XbTJLhecql_HNqyE80Hc6h30A2_elIxliudF4e6Rlz0';
const LH_PROPERTY_ID = '14501';
const LH_BASE_URL = 'https://apac.littlehotelier.com';
const DRY_RUN = false; // ✅ เปิดใช้งานจริงหลังทดสอบ dry run ผ่านแล้ว (2026-07-13)

// room type → LH room_type_id + rate_plan_id (Standard rate plan เท่านั้น)
const ROOM_LH_MAP = {
  Luxury:   { roomTypeId: '77058',  ratePlanId: '169328' },
  Retro:    { roomTypeId: '74782',  ratePlanId: '164707' },
  Allure:   { roomTypeId: '74781',  ratePlanId: '164706' },
  Elegance: { roomTypeId: '74780',  ratePlanId: '164705' },
  Legacy:   { roomTypeId: '77059',  ratePlanId: '169329' },
  Radiance: { roomTypeId: '110160', ratePlanId: '244469' },
};

const PAGE_SIZE_DAYS = 14; // Little Hotelier แสดง 14 วันต่อหน้า

// ── Main entry point ──
function pushRatesToLH() {
  const cookie = PropertiesService.getScriptProperties().getProperty('LH_SESSION_COOKIE');
  if (!cookie) {
    Logger.log('❌ ไม่พบ LH_SESSION_COOKIE ใน Script Properties — ตั้งค่าก่อนรัน');
    return;
  }

  // ── เช็ค session ก่อนแตะราคาจริงแม้แต่หน้าเดียว ──
  if (!checkSessionValid_(cookie)) {
    const ageStr = getSessionAgeStr_();
    Logger.log('❌ Session หมดอายุ (ตรวจพบก่อนเริ่มส่งราคา) — หยุดทันที ยังไม่แตะราคาใดๆ');
    notifySessionExpired(ageStr);
    return;
  }

  const targets = readTargetRates(); // { 'YYYY-MM-DD': { RoomType: rate, ... }, ... }
  const dates = Object.keys(targets).sort();
  if (dates.length === 0) {
    Logger.log('ไม่มีข้อมูลใน Target_Rates — รัน computeTargetRates() ก่อน');
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lastDate = new Date(dates[dates.length - 1] + 'T00:00:00');
  const totalDays = Math.round((lastDate - today) / 86400000) + 1;
  const numPages = Math.ceil(totalDays / PAGE_SIZE_DAYS);

  let successPages = 0, failPages = 0, totalUpdated = 0;

  for (let p = 0; p < numPages; p++) {
    const pageStart = new Date(today);
    pageStart.setDate(today.getDate() + p * PAGE_SIZE_DAYS);
    const startDateStr = Utilities.formatDate(pageStart, 'Asia/Bangkok', 'yyyy-MM-dd');

    try {
      const result = pushOnePage(startDateStr, targets, cookie);
      if (result.sessionExpired) {
        const ageStr = getSessionAgeStr_();
        Logger.log('❌ Session หมดอายุ — อายุ session: ' + ageStr + ' — หยุดทำงานทันที ต้อง login + MFA ใหม่แล้วอัปเดต LH_SESSION_COOKIE');
        notifySessionExpired(ageStr);
        failPages++;
        break;
      }
      successPages++;
      totalUpdated += result.updatedCount;
      Logger.log(`✅ หน้า ${startDateStr}: อัปเดต ${result.updatedCount} ช่อง (dry_run=${DRY_RUN})`);
    } catch (err) {
      Logger.log(`❌ หน้า ${startDateStr} error: ${err}`);
      failPages++;
    }

    Utilities.sleep(1500); // เว้นจังหวะกันโดน rate-limit/บล็อค
  }

  Logger.log(`สรุป: สำเร็จ ${successPages} หน้า, ล้มเหลว ${failPages} หน้า, อัปเดตรวม ${totalUpdated} ช่อง`);
}

// ── ตรวจสอบว่า session ยังใช้ได้ไหม (GET เบาๆ 1 ครั้ง ก่อนแตะราคาจริง) ──
function checkSessionValid_(cookie) {
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const url = `${LH_BASE_URL}/extranet/properties/${LH_PROPERTY_ID}/inventory/edit?start_date=${todayStr}&viewable_fields=detailed`;
  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Cookie: `_littlehotelier_session=${cookie}` },
      muteHttpExceptions: true,
    });
    const html = resp.getContentText();
    return resp.getResponseCode() === 200 && html.indexOf('rate_plan_dates') !== -1;
  } catch (e) {
    Logger.log('checkSessionValid_ error: ' + e);
    return false;
  }
}

// ── คำนวณอายุ session สำหรับข้อความแจ้งเตือน ──
function getSessionAgeStr_() {
  const setAt = PropertiesService.getScriptProperties().getProperty('LH_SESSION_SET_AT');
  return setAt
    ? Math.round((Date.now() - new Date(setAt).getTime()) / 3600000) + ' ชั่วโมง (ตั้งไว้เมื่อ ' + setAt + ')'
    : 'ไม่ทราบ (ไม่มีบันทึกเวลา — sync ผ่าน SessionSync webapp ครั้งหน้าจะเริ่มบันทึกให้)';
}

// ── อ่าน Target_Rates sheet ──
function readTargetRates() {
  const ss = SpreadsheetApp.openById(LH_SHEET_ID);
  const sheet = ss.getSheetByName('Target_Rates');
  if (!sheet) throw new Error('ไม่พบ sheet "Target_Rates"');
  const data = sheet.getDataRange().getValues();
  const targets = {};
  for (let i = 1; i < data.length; i++) {
    const [dateVal, roomType, rate] = data[i];
    if (!dateVal || !roomType || !rate) continue;
    const dateStr = dateVal instanceof Date
      ? Utilities.formatDate(dateVal, 'Asia/Bangkok', 'yyyy-MM-dd')
      : String(dateVal);
    if (!targets[dateStr]) targets[dateStr] = {};
    targets[dateStr][roomType] = Math.round(Number(rate));
  }
  return targets;
}

// ── ประมวลผล 1 หน้า (14 วัน) ──
function pushOnePage(startDateStr, targets, cookie) {
  const url = `${LH_BASE_URL}/extranet/properties/${LH_PROPERTY_ID}/inventory/edit?start_date=${startDateStr}&viewable_fields=detailed`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Cookie: `_littlehotelier_session=${cookie}` },
    muteHttpExceptions: true,
  });

  const html = resp.getContentText();
  if (resp.getResponseCode() !== 200 || html.indexOf('rate_plan_dates') === -1) {
    return { sessionExpired: true, updatedCount: 0 };
  }

  const authToken = extractAuthToken(html);
  const fields = parseFormFields(html); // ordered [[name,value], ...] ของฟอร์มเดิมทั้งหมด
  const fieldMap = {}; // name -> value (ใช้ object เพราะ key ไม่ซ้ำหลัง filter checkbox แล้ว)
  fields.forEach(([name, value]) => { fieldMap[name] = value; });

  // สร้าง page dates (14 วันเรียงจาก startDateStr)
  const pageStart = new Date(startDateStr + 'T00:00:00');
  const pageDates = [];
  for (let i = 0; i < PAGE_SIZE_DAYS; i++) {
    const d = new Date(pageStart);
    d.setDate(pageStart.getDate() + i);
    pageDates.push(Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd'));
  }

  let updatedCount = 0;

  Object.keys(ROOM_LH_MAP).forEach(roomType => {
    const { roomTypeId, ratePlanId } = ROOM_LH_MAP[roomType];
    const rateIds = extractRateIdsForRoom(html, roomTypeId, ratePlanId); // 14 ID เรียงตามวัน
    if (!rateIds || rateIds.length !== PAGE_SIZE_DAYS) {
      Logger.log(`⚠️ ${roomType}: หา rate IDs ไม่ครบ 14 ช่อง (ได้ ${rateIds ? rateIds.length : 0}) — ข้าม`);
      return;
    }

    pageDates.forEach((dateStr, idx) => {
      const targetRate = targets[dateStr] && targets[dateStr][roomType];
      if (targetRate === undefined) return;

      const fieldName = `rate_plan_dates[${rateIds[idx]}][rate]`;
      const currentVal = fieldMap[fieldName];
      const currentRate = currentVal ? Math.round(Number(currentVal)) : null;

      if (currentRate === targetRate) return; // ไม่เปลี่ยน ไม่ต้องนับ/แก้

      Logger.log(`  ${roomType} ${dateStr}: ${currentRate} → ${targetRate}`);
      fieldMap[fieldName] = String(targetRate);
      updatedCount++;
    });
  });

  if (updatedCount === 0) {
    Logger.log(`  (ไม่มีราคาเปลี่ยนแปลงในหน้า ${startDateStr})`);
    return { sessionExpired: false, updatedCount: 0 };
  }

  if (DRY_RUN) {
    return { sessionExpired: false, updatedCount };
  }

  // POST กลับ (รวม authenticity_token ล่าสุดจากหน้านี้)
  fieldMap['authenticity_token'] = authToken;
  const postResp = UrlFetchApp.fetch(`${LH_BASE_URL}/extranet/properties/${LH_PROPERTY_ID}/inventory`, {
    method: 'post',
    headers: { Cookie: `_littlehotelier_session=${cookie}` },
    payload: fieldMap,
    followRedirects: true,
    muteHttpExceptions: true,
  });

  if (postResp.getResponseCode() >= 400) {
    throw new Error(`POST ล้มเหลว status ${postResp.getResponseCode()}`);
  }

  return { sessionExpired: false, updatedCount };
}

// ── ดึง authenticity_token จาก HTML ──
function extractAuthToken(html) {
  const m = html.match(/name="authenticity_token"\s+value="([^"]+)"/);
  if (!m) throw new Error('หา authenticity_token ไม่เจอ — โครงสร้างหน้าอาจเปลี่ยน');
  return m[1].replace(/&#x2B;/g, '+').replace(/&amp;/g, '&');
}

// ── ดึงทุก input field ในฟอร์ม inventory (ไม่รวมฟอร์ม date-picker อื่น) ──
function parseFormFields(html) {
  const formStart = html.indexOf('action="/extranet/properties/' + LH_PROPERTY_ID + '/inventory"');
  if (formStart === -1) throw new Error('หาฟอร์ม inventory ไม่เจอในหน้า HTML');
  const formEnd = html.indexOf('</form>', formStart);
  const formHtml = html.substring(formStart, formEnd);

  const inputRegex = /<input\s+([^>]+)\/?>/g;
  const fields = [];
  let match;
  while ((match = inputRegex.exec(formHtml)) !== null) {
    const tag = match[1];
    const typeMatch = tag.match(/type="([^"]+)"/);
    const nameMatch = tag.match(/name="([^"]+)"/);
    const valueMatch = tag.match(/value="([^"]*)"/);
    if (!nameMatch) continue;

    const type = typeMatch ? typeMatch[1] : 'text';
    const name = nameMatch[1];
    const value = valueMatch ? decodeHtmlEntities(valueMatch[1]) : '';

    if (type === 'checkbox') {
      // เอาเฉพาะ checkbox ที่ checked (unchecked ใช้ hidden default value=0 ที่ parse ไปแล้ว)
      if (/\bchecked\b/.test(tag)) fields.push([name, value]);
    } else if (type === 'hidden' || type === 'text') {
      fields.push([name, value]);
    }
  }
  return fields;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2713;/g, '✓')
    .replace(/&#x2B;/g, '+')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ── ดึง rate_plan_dates ID 14 ตัว (เรียงตามวัน) ของห้อง+rate plan ที่กำหนด ──
function extractRateIdsForRoom(html, roomTypeId, ratePlanId) {
  const anchor = `room_types/${roomTypeId}/rate_plans/${ratePlanId}/edit`;
  const anchorIdx = html.indexOf(anchor);
  if (anchorIdx === -1) return null;

  const rateRowIdx = html.indexOf("class='rate basic'", anchorIdx);
  if (rateRowIdx === -1) return null;
  const rateRowEnd = html.indexOf('</tr>', rateRowIdx);
  const rateRowHtml = html.substring(rateRowIdx, rateRowEnd);

  const idRegex = /rate_plan_dates\[(\d+)\]\[rate\]/g;
  const ids = [];
  let m;
  while ((m = idRegex.exec(rateRowHtml)) !== null) ids.push(m[1]);
  return ids;
}

// ── แจ้งเตือนเมื่อ session หมดอายุ (LINE DM หา admin เท่านั้น, main OA → backup OA) ──
function notifySessionExpired(ageStr) {
  const props = PropertiesService.getScriptProperties();
  const ageLine = ageStr ? ('\nอายุ session: ' + ageStr) : '';
  const message = '⚠️ LH session หมดอายุ — ราคาไม่ได้อัปเดตเข้า Little Hotelier กรุณา login ใหม่แล้ว sync cookie' + ageLine;

  const oaConfigs = [
    { token: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN'), userId: props.getProperty('ADMIN_USER_ID'), label: 'main' },
    { token: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN_BACKUP'), userId: props.getProperty('ADMIN_USER_ID_BACKUP'), label: 'backup' },
  ];

  for (const oa of oaConfigs) {
    if (!oa.token || !oa.userId) {
      Logger.log(`⚠️ ข้าม OA (${oa.label}) — ไม่มี token หรือ userId ใน Script Properties`);
      continue;
    }
    if (sendLinePush_(oa.token, oa.userId, message)) {
      Logger.log(`✅ แจ้งเตือน session หมดอายุ สำเร็จผ่าน OA (${oa.label})`);
      return;
    }
    Logger.log(`⚠️ ส่งผ่าน OA (${oa.label}) ไม่สำเร็จ ลอง OA ถัดไป...`);
  }

  Logger.log('❌ แจ้งเตือนไม่สำเร็จทั้ง main และ backup OA — ไม่มีทางแจ้ง Nathan ได้เลยรอบนี้');
}

// ── ส่ง LINE push message ไปหา userId เดียว ──
function sendLinePush_(token, userId, message) {
  try {
    const resp = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: message }],
      }),
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    if (code === 200) return true;
    Logger.log(`LINE push status ${code}: ${resp.getContentText()}`);
    return false;
  } catch (e) {
    Logger.log('LINE push error: ' + e);
    return false;
  }
}

// ── ตั้ง trigger รันทุกคืน (หลัง computeTargetRates เสร็จสัก 10-15 นาที) ──
function setupNightlyPushTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'pushRatesToLH') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pushRatesToLH')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .nearMinute(20) // เผื่อเวลาให้ computeTargetRates (02:00) รันเสร็จก่อน
    .inTimezone('Asia/Bangkok')
    .create();
  Logger.log('ตั้ง trigger เรียบร้อย: pushRatesToLH ทุกคืน ~02:20');
}

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
// หมายเหตุ: ห่อด้วย try/catch ชั้นนอก เพราะเดิมถ้า error ที่ไม่ใช่ session-expired
// (เช่น exception ตอนอ่าน sheet, network error ตอน checkSessionValid_) จะไม่มีการแจ้งเตือนเลย
function pushRatesToLH() {
  try {
    pushRatesToLH_();
  } catch (err) {
    Logger.log('❌ pushRatesToLH ล้มเหลวทั้งฟังก์ชัน (uncaught): ' + err);
    notifyAdmin_('⚠️ Rate push ล้มเหลว (unexpected error)\nราคาอาจไม่ได้อัปเดตเข้า Little Hotelier\n' + err);
  }
}

function pushRatesToLH_() {
  const cookie = PropertiesService.getScriptProperties().getProperty('LH_SESSION_COOKIE');
  if (!cookie) {
    Logger.log('❌ ไม่พบ LH_SESSION_COOKIE ใน Script Properties — ตั้งค่าก่อนรัน');
    notifyAdmin_('⚠️ Rate push ไม่ทำงาน — ไม่พบ LH_SESSION_COOKIE ใน Script Properties');
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
    notifyAdmin_('⚠️ Rate push ข้าม — sheet "Target_Rates" ว่างเปล่า (computeTargetRates() อาจยังไม่รัน หรือรันแล้ว error)');
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lastDate = new Date(dates[dates.length - 1] + 'T00:00:00');
  const totalDays = Math.round((lastDate - today) / 86400000) + 1;
  const numPages = Math.ceil(totalDays / PAGE_SIZE_DAYS);

  let successPages = 0, failPages = 0, totalUpdated = 0;
  const pageErrors = [];
  const allExtractionFailures = [];

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
      if (result.extractionFailures && result.extractionFailures.length > 0) {
        allExtractionFailures.push(...result.extractionFailures);
      }
      Logger.log(`✅ หน้า ${startDateStr}: อัปเดต ${result.updatedCount} ช่อง (dry_run=${DRY_RUN})`);
    } catch (err) {
      Logger.log(`❌ หน้า ${startDateStr} error: ${err}`);
      pageErrors.push(`${startDateStr}: ${err}`);
      failPages++;
    }

    Utilities.sleep(1500); // เว้นจังหวะกันโดน rate-limit/บล็อค
  }

  Logger.log(`สรุป: สำเร็จ ${successPages} หน้า, ล้มเหลว ${failPages} หน้า, อัปเดตรวม ${totalUpdated} ช่อง`);

  // ── แจ้งเตือนถ้ามีหน้าล้มเหลวที่ไม่ใช่ session-expired (เดิมไม่มีการแจ้งเตือนส่วนนี้เลย) ──
  if (pageErrors.length > 0) {
    notifyAdmin_(
      `⚠️ Rate push มีบางหน้าล้มเหลว (${failPages}/${numPages} หน้า)\n` +
      `สำเร็จ ${successPages} หน้า, อัปเดตรวม ${totalUpdated} ช่อง\n` +
      pageErrors.slice(0, 5).join('\n')
    );
  }

  // ── แจ้งเตือนถ้าหา rate IDs ไม่เจอ (เดิมแค่ log — ห้องนั้นจะค้างราคาเก่าถาวรโดยไม่มีใครรู้) ──
  if (allExtractionFailures.length > 0) {
    notifyAdmin_(
      `⚠️ Rate push หาราคาบางห้องใน LH ไม่เจอ (HTML โครงสร้างอาจเปลี่ยน) — ห้องเหล่านี้จะไม่ถูกอัปเดต:\n` +
      allExtractionFailures.slice(0, 8).join('\n')
    );
  }
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
// dryRunOverride: true = ไม่ POST เด็ดขาด (ใช้กับ diffRatesVsLH) ไม่ขึ้นกับ DRY_RUN const
function pushOnePage(startDateStr, targets, cookie, dryRunOverride) {
  const url = `${LH_BASE_URL}/extranet/properties/${LH_PROPERTY_ID}/inventory/edit?start_date=${startDateStr}&viewable_fields=detailed`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Cookie: `_littlehotelier_session=${cookie}` },
    muteHttpExceptions: true,
  });

  const html = resp.getContentText();
  if (resp.getResponseCode() !== 200 || html.indexOf('rate_plan_dates') === -1) {
    return { sessionExpired: true, updatedCount: 0, diffs: [], extractionFailures: [] };
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
  const diffs = [];
  const extractionFailures = [];

  Object.keys(ROOM_LH_MAP).forEach(roomType => {
    const { roomTypeId, ratePlanId } = ROOM_LH_MAP[roomType];
    const rateIds = extractRateIdsForRoom(html, roomTypeId, ratePlanId); // 14 ID เรียงตามวัน
    if (!rateIds || rateIds.length !== PAGE_SIZE_DAYS) {
      const msg = `${roomType} หน้า ${startDateStr}: หา rate IDs ไม่ครบ 14 ช่อง (ได้ ${rateIds ? rateIds.length : 0})`;
      Logger.log(`⚠️ ${msg} — ข้าม (ราคาห้องนี้จะไม่ถูกอัปเดตในหน้านี้เลย)`);
      extractionFailures.push(msg);
      return;
    }

    pageDates.forEach((dateStr, idx) => {
      const targetRate = targets[dateStr] && targets[dateStr][roomType];
      if (targetRate === undefined) return;

      const fieldName = `rate_plan_dates[${rateIds[idx]}][rate]`;
      const currentVal = fieldMap[fieldName];
      const currentRate = currentVal ? Math.round(Number(currentVal)) : null;

      if (currentRate === targetRate) return; // ไม่เปลี่ยน ไม่ต้องนับ/แก้

      diffs.push({ date: dateStr, roomType, currentRate, targetRate });
      Logger.log(`  ${roomType} ${dateStr}: ${currentRate} → ${targetRate}`);

      if (dryRunOverride) return; // diff-only mode: อย่าแตะ fieldMap/POST

      fieldMap[fieldName] = String(targetRate);
      updatedCount++;
    });
  });

  if (dryRunOverride) {
    return { sessionExpired: false, updatedCount: diffs.length, diffs, extractionFailures };
  }

  if (updatedCount === 0) {
    Logger.log(`  (ไม่มีราคาเปลี่ยนแปลงในหน้า ${startDateStr})`);
    return { sessionExpired: false, updatedCount: 0, diffs, extractionFailures };
  }

  if (DRY_RUN) {
    return { sessionExpired: false, updatedCount, diffs, extractionFailures };
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

  return { sessionExpired: false, updatedCount, diffs, extractionFailures };
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

// ── แจ้งเตือนเมื่อ session หมดอายุ ──
function notifySessionExpired(ageStr) {
  const ageLine = ageStr ? ('\nอายุ session: ' + ageStr) : '';
  notifyAdmin_('⚠️ LH session หมดอายุ — ราคาไม่ได้อัปเดตเข้า Little Hotelier กรุณา login ใหม่แล้ว sync cookie' + ageLine);
}

// ── แจ้งเตือน admin แบบทั่วไป (LINE main OA → backup OA → email fallback) ──
// เดิมมีแค่ path นี้สำหรับ session หมดอายุอย่างเดียว และถ้า LINE ทั้ง 2 OA ส่งไม่ได้
// (token หมดอายุ/ถูก revoke) ก็จะแค่ log ไว้เฉยๆ ไม่มีใครรู้เลย — เพิ่ม email fallback กันเคสนี้
function notifyAdmin_(message) {
  const props = PropertiesService.getScriptProperties();

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
      Logger.log(`✅ แจ้งเตือนสำเร็จผ่าน OA (${oa.label})`);
      return;
    }
    Logger.log(`⚠️ ส่งผ่าน OA (${oa.label}) ไม่สำเร็จ ลอง OA ถัดไป...`);
  }

  // ── LINE ทั้ง 2 OA ส่งไม่ได้ — fallback เป็นอีเมลหา script owner (ไม่พึ่ง token ภายนอก) ──
  try {
    const ownerEmail = props.getProperty('NOTIFY_FALLBACK_EMAIL') || Session.getEffectiveUser().getEmail();
    if (ownerEmail) {
      MailApp.sendEmail(ownerEmail, '⚠️ LH Rate Automation — แจ้งเตือน (LINE ส่งไม่ได้)', message);
      Logger.log(`✅ แจ้งเตือนสำรองผ่านอีเมลสำเร็จ (${ownerEmail})`);
      return;
    }
  } catch (e) {
    Logger.log('❌ ส่งอีเมลสำรองก็ไม่สำเร็จ: ' + e);
  }

  Logger.log('❌ แจ้งเตือนไม่สำเร็จทั้ง LINE (main+backup) และอีเมล — ไม่มีทางแจ้ง Nathan ได้เลยรอบนี้');
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

// ── Diagnostic: เทียบราคาใน Target_Rates กับราคาที่ LH แสดงจริงตอนนี้ โดยไม่แก้อะไรเลย ──
// เขียนผลลง sheet tab "Rate_Diff_Check" (Date | RoomType | LH_Current | Target | CheckedAt)
// ใช้ตอนสงสัยว่า "rate ใน LH ไม่ตรงกับใน sheet" — รันแล้วเปิด tab นี้ดูได้เลยว่าห้อง/วันไหนต่างกันจริง
function diffRatesVsLH() {
  const cookie = PropertiesService.getScriptProperties().getProperty('LH_SESSION_COOKIE');
  if (!cookie) {
    Logger.log('❌ ไม่พบ LH_SESSION_COOKIE');
    notifyAdmin_('⚠️ diffRatesVsLH ทำไม่ได้ — ไม่พบ LH_SESSION_COOKIE');
    return;
  }
  if (!checkSessionValid_(cookie)) {
    notifySessionExpired(getSessionAgeStr_());
    return;
  }

  const targets = readTargetRates();
  const dates = Object.keys(targets).sort();
  if (dates.length === 0) {
    Logger.log('ไม่มีข้อมูลใน Target_Rates');
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lastDate = new Date(dates[dates.length - 1] + 'T00:00:00');
  const totalDays = Math.round((lastDate - today) / 86400000) + 1;
  const numPages = Math.ceil(totalDays / PAGE_SIZE_DAYS);

  const allDiffs = [];
  const allExtractionFailures = [];

  for (let p = 0; p < numPages; p++) {
    const pageStart = new Date(today);
    pageStart.setDate(today.getDate() + p * PAGE_SIZE_DAYS);
    const startDateStr = Utilities.formatDate(pageStart, 'Asia/Bangkok', 'yyyy-MM-dd');
    try {
      const result = pushOnePage(startDateStr, targets, cookie, /* dryRunOverride */ true);
      if (result.sessionExpired) {
        notifySessionExpired(getSessionAgeStr_());
        break;
      }
      allDiffs.push(...result.diffs);
      allExtractionFailures.push(...result.extractionFailures);
    } catch (err) {
      Logger.log(`❌ diffRatesVsLH หน้า ${startDateStr} error: ${err}`);
    }
    Utilities.sleep(1500);
  }

  const ss = SpreadsheetApp.openById(LH_SHEET_ID);
  let sheet = ss.getSheetByName('Rate_Diff_Check');
  if (!sheet) sheet = ss.insertSheet('Rate_Diff_Check');
  sheet.clearContents();
  sheet.appendRow(['Date', 'RoomType', 'LH_Current', 'Target_Rates', 'Diff', 'CheckedAt']);

  const now = new Date().toISOString();
  if (allDiffs.length > 0) {
    const rows = allDiffs.map(d => [d.date, d.roomType, d.currentRate, d.targetRate, d.targetRate - (d.currentRate || 0), now]);
    sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  }
  if (allExtractionFailures.length > 0) {
    sheet.appendRow(['', '', '', '', '', '']);
    sheet.appendRow(['⚠️ หา rate IDs ไม่เจอ (ห้อง/หน้าเหล่านี้เทียบไม่ได้เลย):', '', '', '', '', '']);
    allExtractionFailures.forEach(msg => sheet.appendRow([msg, '', '', '', '', '']));
  }

  Logger.log(`สรุป diffRatesVsLH: พบ ${allDiffs.length} ช่องที่ไม่ตรงกัน, extraction failures ${allExtractionFailures.length} รายการ — ดูรายละเอียดที่ sheet "Rate_Diff_Check"`);

  if (allDiffs.length === 0 && allExtractionFailures.length === 0) {
    notifyAdmin_('✅ diffRatesVsLH: เช็คแล้ว ราคาทุกห้อง/วันที่ตรงกับ Target_Rates ทั้งหมด');
  } else {
    notifyAdmin_(
      `🔍 diffRatesVsLH: พบไม่ตรงกัน ${allDiffs.length} ช่อง` +
      (allExtractionFailures.length > 0 ? `, หา rate ID ไม่เจอ ${allExtractionFailures.length} รายการ` : '') +
      `\nรายละเอียดดูที่ sheet tab "Rate_Diff_Check"`
    );
  }
}

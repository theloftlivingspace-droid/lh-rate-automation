/**
 * LHGuests.gs
 * ---------------------------------------------------------
 * เติมจำนวนแขก (ผู้ใหญ่/เด็ก) ใน Sheet1 จากหน้า Reservations ของ Little Hotelier
 *
 * ทำไม: OTA ส่งจำนวนแขกในอีเมลไม่ครบ แต่ LH เก็บไว้ทุกการจอง (คอลัมน์ Occupants:
 *   fa-user = ผู้ใหญ่, fa-child = เด็ก, fa-pram = ทารก) hotel-line-bot ดึงจากอีเมลก่อน
 *   ไฟล์นี้เป็นตัวสำรอง: เติมเฉพาะแถวที่ Adults/Children/Guests ยังว่าง ไม่ทับค่าเดิมเด็ดขาด
 *   (รวมค่าที่แอดมินกรอกเอง)
 *
 * ใช้เซสชัน LH เดิม (lhFetch_ ใน LHSession.gs) และเขียนลง Sheet1 ในไฟล์ Master
 * (SHEET_ID ใน computeTargetRates.gs — ไฟล์เดียวกับที่ระบบจองใช้)
 *
 * จับคู่แถวด้วย ชื่อแขก + วันเช็คอิน (ตรรกะเดียวกับ guests.js ฝั่งบอท):
 *   LH แสดง "นามสกุล, ชื่อ" / Sheet1 เก็บ "ชื่อ นามสกุล" → เทียบแบบชุด token ไม่สนลำดับ
 *   ถ้าจับคู่ได้หลายแถวที่จำนวนไม่ตรงกัน (เช่น จองหลายห้อง) → ไม่เดา ปล่อยว่าง
 *
 * รันมือ: syncGuestCountsFromLH()  | อัตโนมัติ: keepLhSessionAlive() เรียกทุก ~2 ชม.
 * ---------------------------------------------------------
 */

const LH_GUESTS_SHEET_NAME = 'Sheet1';
const LH_GUESTS_SYNC_EVERY_MS = 2 * 3600 * 1000;
const LH_GUESTS_LOOKBACK_DAYS = 30; // ดึง LH ย้อนก่อนเช็คอินแรกที่ต้องเติม (ให้จับคู่แถวที่ถูกแยกจากการย้ายห้องได้)
const LH_GUESTS_WINDOW_DAYS = 31; // ช่วงวันที่ต่อ 1 คำขอ (ถ้าจำนวนที่ LH บอกไม่ตรงกับแถวที่อ่านได้ จะแบ่งครึ่งซ้ำ)
const LH_GUESTS_HEADERS = { adults: 'Adults', children: 'Children', total: 'Guests' };

// ─────────────── parse หน้า Reservations ───────────────
function lhText_(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

function lhCell_(rowHtml, cls) {
  const m = rowHtml.match(new RegExp("<td class='" + cls + "[^']*'>([\\s\\S]*?)</td>"));
  return m ? m[1] : '';
}

// "16-10-26" → "2026-10-16"
function lhShortDateToIso_(s) {
  const m = String(s || '').match(/(\d{1,2})-(\d{1,2})-(\d{2,4})/);
  if (!m) return '';
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
}

// คืน { found: จำนวนที่ LH บอกว่าเจอ (null ถ้าไม่ใช่หน้า Reservations), rows: [...] }
function lhParseReservations_(html) {
  const fm = String(html || '').match(/(\d+)\s+Reservations?\s+Found/i);
  const rows = [];
  const rowRe = /<tr class='reservation_room_type'>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const r = m[1];
    const guestsCell = lhCell_(r, 'guests');
    let adults = 0, children = 0, infants = 0, seen = false;
    const cRe = /fa-(user|child|pram)[^>]*><\/div>\s*(\d+)/g;
    let c;
    while ((c = cRe.exec(guestsCell)) !== null) {
      seen = true;
      if (c[1] === 'user') adults = parseInt(c[2], 10);
      else if (c[1] === 'child') children = parseInt(c[2], 10);
      else infants = parseInt(c[2], 10);
    }
    const refM = r.match(/class="booking-reference"[^>]*>([^<]+)</);
    rows.push({
      status: lhText_(lhCell_(r, 'status')),
      name: lhText_(lhCell_(r, 'name')),
      reference: refM ? refM[1].trim() : '',
      checkIn: lhShortDateToIso_(lhText_(lhCell_(r, 'check_in'))),
      checkOut: lhShortDateToIso_(lhText_(lhCell_(r, 'check_out'))),
      room: lhText_(lhCell_(r, 'room_name')),
      adults: adults,
      children: children + infants, // ทารกนับรวมในช่อง "เด็ก" (เหมือนฝั่งบอท)
      hasCounts: seen,
    });
  }
  return { found: fm ? parseInt(fm[1], 10) : null, rows: rows };
}

// ─────────────── จับคู่ชื่อ ───────────────
function lhNameTokens_(name) {
  // เทียบแบบไม่สนสำเนียง/รูปแบบ Unicode (č ตัวเดียว = c+เครื่องหมายแยก = c)
  return String(name || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[\s,\/]+/)
    .map(function (t) { return t.replace(/[^\p{L}\p{N}]/gu, ''); })
    .filter(Boolean).sort();
}

function lhNamesMatch_(a, b) {
  if (!a.length || !b.length) return false;
  if (a.join('') === b.join('')) return true;
  const small = a.length <= b.length ? a : b, big = a.length <= b.length ? b : a;
  // ชื่อสั้น/ยาวไม่เท่ากัน → ยอมเมื่อ token ของชื่อสั้นอยู่ในชื่อยาวและมี ≥ 2 token (กันเดาผิด)
  return small.length >= 2 && small.every(function (t) { return big.indexOf(t) !== -1; });
}

function lhRoomNo_(room) {
  const m = String(room || '').match(/\d+/);
  return m ? m[0] : '';
}

// sheetRow = { name, checkIn(ISO), room } → { adults, children } | null
function lhMatchGuests_(sheetRow, lhRows) {
  const mine = lhNameTokens_(sheetRow.name);
  const nameRows = lhRows.filter(function (r) {
    return r.hasCounts && !/cancel|no.?show/i.test(r.status) && lhNamesMatch_(mine, lhNameTokens_(r.name));
  });
  let cands = nameRows.filter(function (r) { return r.checkIn === sheetRow.checkIn; });
  if (!cands.length) {
    // แถวที่ถูกแยกจากการย้ายห้อง (RoomMove: ช่วงต่อ resId ลงท้าย -B ใช้วันย้ายเป็นเช็คอิน) →
    // เช็คอินในชีตอยู่กลางการเข้าพักของการจองเดิมใน LH
    cands = nameRows.filter(function (r) {
      return r.checkOut && r.checkIn < sheetRow.checkIn && sheetRow.checkIn < r.checkOut;
    });
  }
  if (cands.length > 1) { // จองหลายห้อง/ชื่อซ้ำวันเดียวกัน → แยกด้วยเลขห้อง
    const rn = lhRoomNo_(sheetRow.room);
    const byRoom = rn ? cands.filter(function (r) { return lhRoomNo_(r.room) === rn; }) : [];
    if (byRoom.length) cands = byRoom;
  }
  if (!cands.length) return null;
  const first = cands[0];
  const same = cands.every(function (r) { return r.adults === first.adults && r.children === first.children; });
  return same ? { adults: first.adults, children: first.children } : null; // ไม่แน่ใจ = ไม่เดา
}

// อธิบายว่าทำไมแถวนี้จับคู่ไม่ได้ (ไว้อ่านใน Logs): ไม่พบชื่อ / พบชื่อแต่วันไม่ตรง / กำกวม
function lhExplainUnmatched_(n, lhRows) {
  const mine = lhNameTokens_(n.name);
  const same = lhRows.filter(function (r) { return lhNamesMatch_(mine, lhNameTokens_(r.name)); });
  if (!same.length) return 'LH ไม่มีการจองชื่อนี้ในช่วงที่ดึง (ชื่อในชีต/LH ต่างกัน หรือช่วงวันที่/สถานะไม่ครอบคลุม)';
  return 'LH มีชื่อนี้ แต่ไม่ตรงเงื่อนไข: ' + same.slice(0, 3).map(function (r) {
    return '[' + r.checkIn + '→' + r.checkOut + ' ' + r.room + ' ' + r.status + ' ' + (r.hasCounts ? r.adults + '+' + r.children : 'ไม่มีจำนวนแขก') + ']';
  }).join(' ');
}

// ─────────────── เรียก LH ───────────────
function lhReservationsUrl_(fromIso, toIso) {
  const disp = function (iso) { return Utilities.formatDate(new Date(iso + 'T00:00:00+07:00'), 'Asia/Bangkok', 'dd MMM yyyy'); };
  const q = [
    ['guest_last_name', ''], ['booking_reference_id', ''], ['invoice_number', ''],
    ['date_type', 'CheckIn'], ['status', ''], // All — ไม่กรอง confirmed เพราะการจองที่เช็คอินแล้ว/Direct อาจมีสถานะอื่น
    ['date_from_display', disp(fromIso)], ['date_from', fromIso],
    ['date_to_display', disp(toIso)], ['date_to', toIso],
    ['channel_id', ''],
  ];
  return LH_BASE_URL + '/extranet/properties/' + LH_PROPERTY_ID + '/reservations?' +
    q.map(function (kv) { return 'reservation_filter%5B' + kv[0] + '%5D=' + encodeURIComponent(kv[1]); }).join('&') + '&button=';
}

function lhAddDays_(iso, n) {
  const d = new Date(iso + 'T00:00:00+07:00');
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
}
function lhDaysBetween_(a, b) {
  return Math.round((new Date(b + 'T00:00:00+07:00') - new Date(a + 'T00:00:00+07:00')) / 86400000);
}

// คืน { ok:true, rows } | { ok:false, reason:'expired'|'transient' }
function lhFetchReservations_(fromIso, toIso) {
  const resp = lhFetch_(lhReservationsUrl_(fromIso, toIso), { method: 'get', muteHttpExceptions: true });
  const code = resp.getResponseCode();
  if (code === 429 || code >= 500) return { ok: false, reason: 'transient' };
  const parsed = lhParseReservations_(resp.getContentText());
  if (code !== 200 || parsed.found === null) return { ok: false, reason: 'expired' }; // หน้า login / หน้าอื่น
  // LH อาจแบ่งหน้า — ถ้าจำนวนที่แสดงไม่ตรงกับแถวที่อ่านได้ ให้แบ่งช่วงวันเล็กลง
  if (parsed.found !== parsed.rows.length && lhDaysBetween_(fromIso, toIso) > 7) {
    const mid = lhAddDays_(fromIso, Math.floor(lhDaysBetween_(fromIso, toIso) / 2));
    const a = lhFetchReservations_(fromIso, mid);
    if (!a.ok) return a;
    const b = lhFetchReservations_(lhAddDays_(mid, 1), toIso);
    if (!b.ok) return b;
    return { ok: true, rows: a.rows.concat(b.rows) };
  }
  if (parsed.found !== parsed.rows.length) {
    Logger.log('⚠️ LH บอกเจอ ' + parsed.found + ' แต่อ่านได้ ' + parsed.rows.length + ' แถว (' + fromIso + ' ถึง ' + toIso + ') — ใช้เท่าที่อ่านได้');
  }
  return { ok: true, rows: parsed.rows };
}

// ─────────────── Sheet1 ───────────────
function lhCellIso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
  return String(v || '').trim().slice(0, 10);
}
function lhBlank_(v) { return v === '' || v === null || v === undefined || String(v).trim() === ''; }

function lhEnsureGuestColumns_(sh, header) {
  const idx = {};
  let last = header.length;
  Object.keys(LH_GUESTS_HEADERS).forEach(function (k) {
    let i = header.indexOf(LH_GUESTS_HEADERS[k]);
    if (i < 0) {
      i = last++;
      sh.getRange(1, i + 1).setValue(LH_GUESTS_HEADERS[k]);
      header[i] = LH_GUESTS_HEADERS[k];
    }
    idx[k] = i;
  });
  return idx;
}

// public: รันมือได้ (ขอ lock เอง)
function syncGuestCountsFromLH() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('syncGuestCountsFromLH: มีงานอื่นถือ lock อยู่ ข้าม'); return null; }
  try { return syncGuestCountsFromLH_(); } finally { lock.releaseLock(); }
}

// ตัวทำงานจริง (ผู้เรียกต้องถือ lock เอง — เช่น keepLhSessionAlive)
function syncGuestCountsFromLH_() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(LH_GUESTS_SHEET_NAME);
  if (!sh) { Logger.log('ไม่พบแท็บ ' + LH_GUESTS_SHEET_NAME); return null; }
  const values = sh.getDataRange().getValues();
  const header = values[0].map(function (h) { return String(h || '').trim(); });
  const cName = header.indexOf('ชื่อแขก'), cIn = header.indexOf('เช็คอิน'), cOut = header.indexOf('เช็คเอาท์'), cRoom = header.indexOf('เลขห้อง');
  if (cName < 0 || cIn < 0 || cOut < 0 || cRoom < 0) throw new Error('หาหัวคอลัมน์ ชื่อแขก/เช็คอิน/เช็คเอาท์/เลขห้อง ใน ' + LH_GUESTS_SHEET_NAME + ' ไม่เจอ');
  const hasCols = header.indexOf(LH_GUESTS_HEADERS.adults) >= 0 && header.indexOf(LH_GUESTS_HEADERS.children) >= 0 && header.indexOf(LH_GUESTS_HEADERS.total) >= 0;
  const gi = {
    adults: header.indexOf(LH_GUESTS_HEADERS.adults),
    children: header.indexOf(LH_GUESTS_HEADERS.children),
    total: header.indexOf(LH_GUESTS_HEADERS.total),
  };

  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const need = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const name = String(row[cName] || '').trim();
    const room = String(row[cRoom] || '');
    if (!name || /cancel|ยกเลิก/i.test(room)) continue;
    if (/mycondo/i.test(room)) continue; // ห้อง Mycondo (Airbnb direct) ไม่อยู่ใน LH — จำนวนแขกมาจากอีเมลฝั่งบอท
    const checkOut = lhCellIso_(row[cOut]);
    if (!checkOut || checkOut < today) continue; // เฉพาะที่ยังไม่เช็คเอาท์ (ปัจจุบัน/อนาคต)
    if (hasCols && !(lhBlank_(row[gi.adults]) && lhBlank_(row[gi.children]) && lhBlank_(row[gi.total]))) continue; // มีค่าแล้ว ไม่แตะ
    const checkIn = lhCellIso_(row[cIn]);
    if (!checkIn) continue;
    need.push({ rowNumber: i + 1, name: name, checkIn: checkIn, room: room });
  }
  if (!need.length) { Logger.log('syncGuestCountsFromLH: ไม่มีแถวที่ต้องเติม'); return { needed: 0, updated: 0, unmatched: 0 }; }

  // ดึง LH ครอบช่วงเช็คอินของแถวที่ต้องเติม แบ่งเป็นก้อนละ LH_GUESTS_WINDOW_DAYS วัน
  const ins = need.map(function (n) { return n.checkIn; }).sort();
  const minIn = lhAddDays_(ins[0], -LH_GUESTS_LOOKBACK_DAYS); // ย้อนไปเผื่อแถวที่ถูกแยก (เช็คอินเดิมใน LH เร็วกว่าในชีต)
  const maxIn = ins[ins.length - 1];
  let lhRows = [];
  for (let from = minIn; from <= maxIn; from = lhAddDays_(from, LH_GUESTS_WINDOW_DAYS + 1)) {
    let to = lhAddDays_(from, LH_GUESTS_WINDOW_DAYS);
    if (to > maxIn) to = maxIn;
    const res = lhFetchReservations_(from, to);
    if (!res.ok) { Logger.log('syncGuestCountsFromLH หยุด: LH ' + res.reason + ' — ไม่เขียนอะไร'); return { needed: need.length, updated: 0, unmatched: need.length, aborted: res.reason }; }
    lhRows = lhRows.concat(res.rows);
    Utilities.sleep(800);
  }

  const idx = lhEnsureGuestColumns_(sh, header);
  let updated = 0, unmatched = 0;
  need.forEach(function (n) {
    const g = lhMatchGuests_(n, lhRows);
    if (!g || g.adults + g.children <= 0) {
      unmatched++;
      if (unmatched <= 10) Logger.log('⚠️ จับคู่ไม่ได้: แถว ' + n.rowNumber + ' | ' + n.room + ' | ' + n.name + ' | เช็คอิน ' + n.checkIn + ' → ' + lhExplainUnmatched_(n, lhRows));
      return;
    }
    // อ่านซ้ำก่อนเขียน: ถ้าบอท/แอดมินเพิ่งเติมไประหว่างนี้ → ไม่ทับ
    const cur = sh.getRange(n.rowNumber, 1, 1, Math.max(idx.adults, idx.children, idx.total) + 1).getValues()[0];
    if (!(lhBlank_(cur[idx.adults]) && lhBlank_(cur[idx.children]) && lhBlank_(cur[idx.total]))) return;
    sh.getRange(n.rowNumber, idx.adults + 1).setValue(g.adults);
    sh.getRange(n.rowNumber, idx.children + 1).setValue(g.children);
    sh.getRange(n.rowNumber, idx.total + 1).setValue(g.adults + g.children);
    updated++;
  });
  Logger.log('✅ syncGuestCountsFromLH: ต้องเติม ' + need.length + ' แถว → เติมได้ ' + updated + ', จับคู่ไม่ได้ ' + unmatched);
  return { needed: need.length, updated: updated, unmatched: unmatched };
}

// เรียกจาก keepLhSessionAlive() หลังยืนยันว่า session ใช้ได้ — จำกัดทุก ~2 ชม. และไม่ให้ error ลาม
function lhMaybeSyncGuests_() {
  const props = PropertiesService.getScriptProperties();
  const last = parseInt(props.getProperty('LH_GUESTS_SYNCED_AT'), 10) || 0;
  if (Date.now() - last < LH_GUESTS_SYNC_EVERY_MS) return;
  try {
    const r = syncGuestCountsFromLH_();
    if (r && !r.aborted) props.setProperty('LH_GUESTS_SYNCED_AT', String(Date.now()));
  } catch (e) {
    Logger.log('lhMaybeSyncGuests_ error (ไม่กระทบ keep-alive): ' + e);
  }
}

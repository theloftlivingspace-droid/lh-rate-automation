/**
 * RateReasons.gs — อธิบาย "ทำไมราคานี้" ต่อวัน/ประเภทห้อง (AI-PMS: ราคาพร้อมเหตุผล)
 *
 * อ่านอย่างเดียว: ใช้ฟังก์ชัน mult เดิมของ computeTargetRates.gs ประกอบคำอธิบาย
 * ไม่แก้สูตร ไม่แตะ Target_Rates ไม่เกี่ยวกับการ push เข้า LH — เขียนลงแท็บแยก "Rate_Reasons"
 * และห่อด้วย try/catch ทุกจุด ถ้าพังจะข้ามเงียบๆ ไม่กระทบ pipeline ราคา
 */
const RATE_REASONS_SHEET = 'Rate_Reasons';
const DOW_TH_ = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const SEASON_TH_ = { low: 'ฤดูต่ำ', normal: 'ฤดูปกติ', high: 'ฤดูสูง', peak: 'ช่วงเทศกาล/พีค' };

// ปัจจัยที่ทำให้ราคาต่างจากราคาฐาน (เฉพาะตัวที่ไม่ใช่ ×1.00)
function rateFactors_(roomType, date, occPct, daysAhead) {
  const out = [];
  const add = (key, label, mult) => {
    if (isFinite(mult) && Math.abs(mult - 1) >= 0.005) out.push({ key: key, label: label, mult: Math.round(mult * 1000) / 1000 });
  };
  add('dow', 'วัน' + DOW_TH_[date.getDay()], getDowMult(date));
  const season = getSeasonForDate(date);
  add('season', SEASON_TH_[season] || season, SEASON_MULT[season]);
  const occLabel = (occPct > 75 ? 'ห้องเริ่มเต็ม' : 'ขายได้น้อย') + ' (' + Math.round(occPct) + '%)';
  add('occ', occLabel, getOccMult(occPct));
  const leadLabel = daysAhead <= 7
    ? (occPct < LOW_OCC_THRESHOLD ? 'ใกล้วันเข้าพักแต่ยังขายไม่ออก' : 'ใกล้วันเข้าพัก')
    : 'จองล่วงหน้า ' + daysAhead + ' วัน';
  add('lead', leadLabel, getLeadMult(daysAhead, occPct));
  add('promo', 'โปรโมชัน', getPromoMult(date, occPct));
  add('extraPromo', 'โปรเสริม', getExtraPromoMult(date, occPct));
  add('adjust', 'ปรับขึ้นตามสั่ง', getAdjustmentMult(date));
  add('flood', 'ลดช่วงน้ำท่วม', getFloodMult(date));
  return out;
}

// ราคาก่อนชนเพดาน/พื้น (ปัดเป็นหลัก 50 เหมือน calcRate) — ใช้ยืนยันว่าคำอธิบายตรงกับสูตรจริง
function rateUnclamped_(roomType, factors) {
  let p = getEffectiveBase_(roomType);
  factors.forEach(f => { p *= f.mult; });
  return Math.round(p / 50) * 50;
}

function explainRate_(roomType, date, occPct, daysAhead, rawRate, prevRate, finalRate, dateStr) {
  const cfg = ROOM_CONFIG[roomType];
  const base = getEffectiveBase_(roomType);
  const factors = rateFactors_(roomType, date, occPct, daysAhead);
  const floor = Math.round((cfg.min * 1.1) / 50) * 50;
  const ceiling = Math.round((cfg.max * 0.9) / 50) * 50;
  const unclamped = rateUnclamped_(roomType, factors);

  const drivers = factors.slice()
    .sort((a, b) => Math.abs(Math.log(b.mult)) - Math.abs(Math.log(a.mult)))
    .slice(0, 3)
    .map(f => f.label + ' (' + (f.mult >= 1 ? '+' : '') + Math.round((f.mult - 1) * 100) + '%)');

  const notes = [];
  if (unclamped < floor) notes.push('ชนราคาต่ำสุดที่ตั้งไว้ ฿' + floor);
  else if (unclamped > ceiling) notes.push('ชนราคาสูงสุดที่ตั้งไว้ ฿' + ceiling);
  if (prevRate != null && isFinite(prevRate) && prevRate > 0 && finalRate !== rawRate) {
    notes.push('ปรับทีละไม่เกิน ' + RATE_CHANGE_CAP_PCT + '%: เป้า ฿' + rawRate + ' แต่เปลี่ยนจาก ฿' + prevRate + ' เป็น ฿' + finalRate);
  }
  const held = dateStr && (
    (typeof BLACKOUT_DATES !== 'undefined' && BLACKOUT_DATES.has && BLACKOUT_DATES.has(dateStr)) ||
    (typeof isManualHold_ === 'function' && isManualHold_(dateStr)));
  if (held) notes.push('ช่วงตั้งราคามือ: ระบบไม่ส่งราคานี้เข้า LH');

  let reason = '฿' + finalRate + ' (ราคาฐาน ฿' + base + ')';
  reason += drivers.length ? ' ปัจจัยหลัก: ' + drivers.join(', ') : ' ไม่มีปัจจัยปรับ';
  if (notes.length) reason += ' · ' + notes.join(' · ');
  return { reason: reason, factors: factors, base: base, notes: notes };
}

function buildRateReasonRow_(dateStr, roomType, date, occPct, daysAhead, rawRate, prevRate, finalRate, nowIso) {
  const e = explainRate_(roomType, date, occPct, daysAhead, rawRate, prevRate, finalRate, dateStr);
  return [dateStr, roomType, finalRate, prevRate == null ? '' : prevRate, rawRate, e.base, e.reason, JSON.stringify(e.factors), nowIso];
}

function writeRateReasons_(ss, rows) {
  if (!rows || !rows.length) return;
  let sheet = ss.getSheetByName(RATE_REASONS_SHEET);
  if (!sheet) sheet = ss.insertSheet(RATE_REASONS_SHEET);
  sheet.clearContents();
  sheet.appendRow(['Date', 'RoomType', 'Rate', 'PrevRate', 'RawRate', 'Base', 'Reason', 'Factors', 'UpdatedAt']);
  sheet.getRange(2, 1, rows.length, 9).setValues(rows);
  Logger.log('เขียน Rate_Reasons สำเร็จ: ' + rows.length + ' แถว');
}

// ── อ่าน Rate_Reasons ให้แดชบอร์ด (เรียกผ่าน doGet action=rateReasons — อ่านอย่างเดียว ตรวจ token ที่ doGet แล้ว) ──
// params: from / to (yyyy-MM-dd, ไม่บังคับ), room (ไม่บังคับ) · คืนไม่เกิน 400 แถว เรียงตามวันที่แล้วประเภทห้อง
function readRateReasons_(params) {
  params = params || {};
  const ss = SpreadsheetApp.openById(OUTPUT_SHEET_ID);
  const sheet = ss.getSheetByName(RATE_REASONS_SHEET);
  const vals = sheet ? sheet.getDataRange().getValues() : [];
  // ยังไม่เคยมีรอบคำนวณที่บันทึกเหตุผล → อธิบายจากราคาปัจจุบันใน Target_Rates ทันที (ไม่ต้องรอรอบถัดไป)
  if (vals.length <= 1) return readReasonsFromTargetRates_(ss, params);
  const iso = v => (v instanceof Date ? Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd') : String(v == null ? '' : v).slice(0, 10));
  const okDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const from = okDate(params.from) ? params.from : '';
  const to = okDate(params.to) ? params.to : '';
  const room = typeof params.room === 'string' ? params.room.slice(0, 20) : '';
  const rows = [];
  let updatedAt = '';
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    const d = iso(r[0]);
    if (!okDate(d)) continue;
    if (from && d < from) continue;
    if (to && d > to) continue;
    if (room && String(r[1]) !== room) continue;
    let factors = [];
    try { factors = JSON.parse(r[7] || '[]'); } catch (e) { factors = []; }
    const num = v => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
    rows.push({ date: d, room: String(r[1]), rate: num(r[2]), prev: num(r[3]), raw: num(r[4]), base: num(r[5]), reason: String(r[6] || ''), factors: factors });
    updatedAt = String(r[8] || updatedAt);
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.room < b.room ? -1 : 1));
  return { ok: true, rows: rows.slice(0, 400), updatedAt: updatedAt };
}

// ── ทางสำรอง: สร้างเหตุผลจาก Target_Rates ปัจจุบัน (Date, RoomType, Rate, Occ%, DaysAhead, UpdatedAt) ──
// ใช้สูตรเดียวกับ calcRate ณ ตอนอ่าน; ไม่มีราคาก่อนหน้า (ramp) จึงบอกแค่ว่ายังไม่ถึงราคาเป้า
function readReasonsFromTargetRates_(ss, params) {
  const sheet = ss.getSheetByName('Target_Rates');
  if (!sheet) return { ok: true, rows: [], updatedAt: '', note: 'ยังไม่มีแท็บ Target_Rates (ยังไม่เคยคำนวณราคา)' };
  const vals = sheet.getDataRange().getValues();
  const iso = v => (v instanceof Date ? Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd') : String(v == null ? '' : v).slice(0, 10));
  const okDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const from = okDate(params.from) ? params.from : '';
  const to = okDate(params.to) ? params.to : '';
  const room = typeof params.room === 'string' ? params.room.slice(0, 20) : '';
  const rows = [];
  let updatedAt = '';
  for (let i = 1; i < vals.length && rows.length < 400; i++) {
    const r = vals[i];
    const d = iso(r[0]);
    const roomType = String(r[1] || '');
    if (!okDate(d) || !ROOM_CONFIG[roomType]) continue;
    if (from && d < from) continue;
    if (to && d > to) continue;
    if (room && roomType !== room) continue;
    const rate = Number(r[2]), occ = Number(r[3]), ahead = Number(r[4]);
    if (!isFinite(rate) || !isFinite(occ) || !isFinite(ahead)) continue;
    const date = new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
    try {
      const raw = calcRate(roomType, date, occ, ahead);
      const e = explainRate_(roomType, date, occ, ahead, raw, null, rate, d);
      const lag = rate !== raw ? ' · ยังไม่ถึงราคาเป้า ฿' + raw + ' (ปรับทีละไม่เกิน ' + RATE_CHANGE_CAP_PCT + '% ต่อคืน)' : '';
      rows.push({ date: d, room: roomType, rate: rate, prev: null, raw: raw, base: e.base, reason: e.reason + lag, factors: e.factors });
      updatedAt = String(r[5] || updatedAt);
    } catch (err) { /* ข้ามแถวที่อธิบายไม่ได้ */ }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.room < b.room ? -1 : 1));
  return { ok: true, rows: rows, updatedAt: updatedAt, source: 'target_rates', note: 'อธิบายจากราคาปัจจุบันใน Target_Rates (ยังไม่มีรอบคำนวณที่บันทึกเหตุผลและราคาเดิมไว้)' };
}

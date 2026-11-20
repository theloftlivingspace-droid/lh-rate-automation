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

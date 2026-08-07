/**
 * computeTargetRates.gs
 * ---------------------------------------------------------
 * คำนวณราคาแนะนำรายวัน (วันนี้ ถึง +90 วัน) สำหรับทุกห้อง
 * โดยใช้สูตร: price = base × DOW_mult × Season_mult × Occupancy_mult × LeadTime_mult
 * (ไม่พึ่งพา PriceLabs — occupancy คำนวณสดจาก Bookings sheet ทุกครั้งที่รัน)
 *
 * ผลลัพธ์เขียนลง sheet tab "Target_Rates" คอลัมน์: Date | RoomType | Rate | Occ | DaysAhead
 *
 * ตั้ง trigger: รันฟังก์ชัน computeTargetRates() ทุกคืน (เช่น 02:00)
 * ---------------------------------------------------------
 */

const SHEET_ID = '1XbTJLhecql_HNqyE80Hc6h30A2_elIxliudF4e6Rlz0'; // Master sheet — อ่าน Bookings เท่านั้น
const OUTPUT_SHEET_ID = '1gjYsvg7YZR7hvjfsQPIy78TJhK49RKIDFQn90bREus8'; // ไฟล์แยก — เขียน Target_Rates (แยกออกจาก Master 7 ส.ค. 2026 กัน SpreadsheetApp ช้า/timeout จากไฟล์ Master ที่โตขึ้นเรื่อยๆ)
const DAYS_AHEAD_TO_COMPUTE = 90;

// ── ค่าคงที่ห้องพัก (จาก ROOMS_DATA ใน loft-pricing dashboard) ──
const ROOM_CONFIG = {
  Luxury:   { base: 867, min: 450, max: 1800, count: 1 },
  Retro:    { base: 865, min: 400, max: 1500, count: 1 },
  Allure:   { base: 907, min: 500, max: 1400, count: 2 },
  Elegance: { base: 871, min: 360, max: 1300, count: 2 },
  Legacy:   { base: 882, min: 360, max: 1300, count: 2 },
  Radiance: { base: 851, min: 380, max: 1350, count: 2 },
};

// ── DOW multiplier ──
// จันทร์-พฤหัส = 1.0, ศุกร์ = 1.02, เสาร์-อาทิตย์ = 1.09 (ลดช่วงห่างจากวันธรรมดาลงอีก เมื่อ 29 ก.ค. 2026)
function getDowMult(date) {
  const d = date.getDay(); // 0=Sun ... 6=Sat
  if (d === 0 || d === 6) return 1.09;
  if (d === 5) return 1.02;
  return 1.0;
}

// ── Season multiplier ──
const SEASON_MULT = { low: 0.85, normal: 1.0, high: 1.25, peak: 1.5 };
function getSeasonForDate(date) {
  const m = date.getMonth(), d = date.getDate();
  const songkran = m === 3 && d >= 13 && d <= 14;
  const newyear = (m === 11 && d >= 30) || (m === 0 && d <= 2);
  if (songkran || newyear) return 'peak';
  if (m >= 10 || m <= 1) return 'high';
  if (m >= 4 && m <= 8) return 'low';
  return 'normal';
}

// ── Occupancy multiplier ──
// อัปเดต 8 ส.ค. 2026: เปลี่ยนจาก step function เป็นเส้นต่อเนื่อง (interpolation) เพราะห้องที่มี 1-2 ห้อง
// occupancy คำนวณจากหน้าต่าง 7 คืน (getWeekOccupancy) ทำให้ occ กระโดดทีละ ~7-14 จุดต่อการจอง 1 ครั้ง
// ถ้าใช้ step function จุดกระโดดของ occ อาจข้าม tier boundary 2 เส้นพร้อมกัน ราคาเลยกระโดดแรงเกินไป
// เส้นต่อเนื่องทำให้ราคาขยับตามสัดส่วน occ จริง ไม่ถูกขยายจากตำแหน่ง tier พอดี
// และลดความชันของทั้งเส้นลงครึ่งหนึ่งด้วย (บีบเข้าหา 1.0) กัน over-react ตอน occ เปลี่ยนเร็ว
const OCC_ANCHORS = [
  [0,   0.25],
  [100, 0.72],
];
function getOccMult(occPct) {
  const pts = OCC_ANCHORS;
  if (occPct <= pts[0][0]) return pts[0][1];
  if (occPct >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (occPct >= x0 && occPct <= x1) {
      return y0 + (y1 - y0) * (occPct - x0) / (x1 - x0);
    }
  }
  return 1.0;
}

// ── Promo: ลดราคาโดยรวม -10% ชั่วคราว ถึงสิ้นเดือน (ตั้ง 20 ก.ค. 2026) ──
const PROMO_DISC_PCT = 10;
const PROMO_END_DATE = new Date(2026, 6, 31); // 31 ก.ค. 2026 (month index 6 = July)
function getPromoMult(date) {
  const d = new Date(date); d.setHours(0,0,0,0);
  const end = new Date(PROMO_END_DATE); end.setHours(0,0,0,0);
  return d <= end ? 1 - (PROMO_DISC_PCT / 100) : 1.0;
}

// ── Lead time discount ──
const LEAD_TIME_RULES = [
  { minDays: 75, discPct: 22 },
  { minDays: 45, discPct: 15 },
  { minDays: 28, discPct: 9 },
  { minDays: 14, discPct: 4 },
  { minDays: 7,  discPct: -6 },
  { minDays: 0,  discPct: -18 },
];
function getLeadMult(daysAhead) {
  const rule = LEAD_TIME_RULES.find(r => daysAhead >= r.minDays) || LEAD_TIME_RULES[LEAD_TIME_RULES.length - 1];
  return 1 - (rule.discPct / 100);
}

// ── คำนวณราคาสุดท้าย ──
function calcRate(roomType, date, occPct, daysAhead) {
  const cfg = ROOM_CONFIG[roomType];
  const dowMult = getDowMult(date);
  const season = getSeasonForDate(date);
  const seasonMult = SEASON_MULT[season];
  const occMult = getOccMult(occPct);
  const leadMult = getLeadMult(daysAhead);
  const promoMult = getPromoMult(date);

  let price = cfg.base * dowMult * seasonMult * occMult * leadMult * promoMult;
  price = Math.round(price / 50) * 50;

  const floor = Math.round((cfg.min * 1.1) / 50) * 50;
  const ceiling = Math.round((cfg.max * 0.9) / 50) * 50;
  return Math.max(floor, Math.min(ceiling, price));
}

// ── อ่าน Bookings sheet แล้วคำนวณ occupancy ล่วงหน้ารายสัปดาห์ต่อห้อง ──
// คืนค่า object: { "RoomType_YYYY-MM-DD(สัปดาห์เริ่ม)": occPct }
function computeAdvanceOccupancy() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = ss.getSheetByName('Bookings') || ss.getSheetByName('bookings') || ss.getSheets()[0];
  const data = ws.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim());

  const roomTypeCol = headers.findIndex(h => /room.?type|เลขห้อง|ห้อง/i.test(h));
  const checkinCol = headers.findIndex(h => /check.?in|เช็ค.?อิน/i.test(h));
  const checkoutCol = headers.findIndex(h => /check.?out|เช็ค.?เอาท์/i.test(h));
  const statusCol = headers.findIndex(h => /status|สถานะ/i.test(h));

  if (roomTypeCol === -1 || checkinCol === -1 || checkoutCol === -1) {
    throw new Error('หา column RoomType/CheckIn/CheckOut ใน Bookings sheet ไม่เจอ — เช็คชื่อ header');
  }

  // นับจำนวนคืนที่ถูกจองต่อห้อง ต่อวัน (booked-night map)
  const bookedNights = {}; // key: "RoomType_YYYY-MM-DD" => count

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[roomTypeCol] || !row[checkinCol] || !row[checkoutCol]) continue;
    if (statusCol !== -1 && /cancel/i.test(String(row[statusCol]))) continue;

    const roomCell = String(row[roomTypeCol]);
    // เซลล์บางแถวมีคำว่ายกเลิก/no show ปนอยู่ (เช่น "203 ยกเลิก", "205 Allure ยกเลิก") — ข้ามทันที
    if (/ยกเลิก|cancel|no ?show/i.test(roomCell)) continue;

    const roomType = normalizeRoomType(roomCell);
    if (!ROOM_CONFIG[roomType]) continue;

    let ci = new Date(row[checkinCol]);
    let co = new Date(row[checkoutCol]);
    if (isNaN(ci) || isNaN(co)) continue;
    ci.setHours(0,0,0,0); co.setHours(0,0,0,0);

    for (let d = new Date(ci); d < co; d.setDate(d.getDate() + 1)) {
      const key = roomType + '_' + Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
      bookedNights[key] = (bookedNights[key] || 0) + 1;
    }
  }
  return bookedNights;
}

// แปลงชื่อ room type จาก Bookings sheet ให้ตรงกับ ROOM_CONFIG keys
const ROOM_NUMBER_TO_TYPE = {
  '103': 'Elegance',
  '108': 'Retro',
  '113': 'Legacy',
  '203': 'Allure',
  '204': 'Elegance',
  '205': 'Allure',
  '209': 'Radiance',
  '210': 'Radiance',
  '214': 'Legacy',
  '300': 'Luxury',
  '363': 'Mycondo', // ไม่อยู่ใน ROOM_CONFIG — จะถูกข้ามอัตโนมัติ
};

function normalizeRoomType(raw) {
  const s = raw.toLowerCase();
  if (s.includes('lux')) return 'Luxury';
  if (s.includes('retro')) return 'Retro';
  if (s.includes('allure')) return 'Allure';
  if (s.includes('elegance') || s.includes('elegan')) return 'Elegance';
  if (s.includes('legacy')) return 'Legacy';
  if (s.includes('radiance')) return 'Radiance';

  // ไม่มีชื่อประเภทห้องในเซลล์ (เช่นมีแค่เลขห้อง) — fallback ไปดูจากเลขห้องนำหน้า
  const m = raw.match(/^(\d+)/);
  if (m && ROOM_NUMBER_TO_TYPE[m[1]]) return ROOM_NUMBER_TO_TYPE[m[1]];

  return raw; // ไม่ match จะถูกข้ามใน ROOM_CONFIG check
}

// occupancy ของ "สัปดาห์" ที่ครอบคลุมวันที่กำหนด (Mon-Sun) เป็น %
function getWeekOccupancy(roomType, date, bookedNights) {
  const cfg = ROOM_CONFIG[roomType];
  const dow = date.getDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(date);
  monday.setDate(date.getDate() + mondayOffset);

  let nights = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = roomType + '_' + Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
    nights += bookedNights[key] || 0;
  }
  const capacity = 7 * cfg.count;
  return capacity > 0 ? Math.round((nights / capacity) * 100) : 0;
}

// ── Main entry point — รันทุกคืนผ่าน time-based trigger ──
// หมายเหตุ: ห่อด้วย try/catch เพราะเดิมถ้า error (เช่น เปลี่ยนชื่อ header ใน Bookings sheet)
// จะไม่มีการแจ้งเตือนใดๆ เลย — และ pushRatesToLH ที่รันต่อ 20 นาทีให้หลังก็จะเจอ Target_Rates ว่าง/เก่า
function computeTargetRates() {
  try {
    computeTargetRates_();
  } catch (err) {
    Logger.log('❌ computeTargetRates ล้มเหลว: ' + err);
    notifyAdmin_('⚠️ คำนวณ Target Rate ล้มเหลว — sheet "Target_Rates" จะไม่ถูกอัปเดตคืนนี้ (rate push ที่ตามมาจะข้ามหรือใช้ราคาเก่า)\n' + err);
  }
}

function computeTargetRates_() {
  // ── 1) คำนวณให้เสร็จทั้งหมดก่อน (ยังไม่แตะ sheet) ──
  // เดิม: sheet.clearContents() รันก่อน แล้วค่อยคำนวณ — ถ้า computeAdvanceOccupancy()
  // throw กลางทาง (เช่น หา column ใน Bookings sheet ไม่เจอ) จะเหลือ Target_Rates ว่างเปล่า
  // ค้างอยู่แบบนั้นทุกคืน เพราะ error เกิดหลังเคลียร์ไปแล้ว — สลับลำดับกันไม่ให้เกิดซ้ำ
  const bookedNights = computeAdvanceOccupancy();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows = [];
  const now = new Date().toISOString();

  for (let dOffset = 0; dOffset <= DAYS_AHEAD_TO_COMPUTE; dOffset++) {
    const date = new Date(today);
    date.setDate(today.getDate() + dOffset);

    Object.keys(ROOM_CONFIG).forEach(roomType => {
      const occ = getWeekOccupancy(roomType, date, bookedNights);
      const rate = calcRate(roomType, date, occ, dOffset);
      rows.push([
        Utilities.formatDate(date, 'Asia/Bangkok', 'yyyy-MM-dd'),
        roomType,
        rate,
        occ,
        dOffset,
        now,
      ]);
    });
  }

  if (rows.length === 0) {
    throw new Error('คำนวณได้ 0 แถว — ไม่เขียนทับ Target_Rates เดิม (ป้องกันชีตว่าง)');
  }

  // ── 2) คำนวณสำเร็จแล้วเท่านั้นถึงจะเคลียร์+เขียนทับ sheet (ไฟล์แยก ไม่ใช่ Master) ──
  const ss = SpreadsheetApp.openById(OUTPUT_SHEET_ID);
  let sheet = ss.getSheetByName('Target_Rates');
  if (!sheet) {
    sheet = ss.insertSheet('Target_Rates');
  }
  sheet.clearContents();
  sheet.appendRow(['Date', 'RoomType', 'Rate', 'Occ%', 'DaysAhead', 'UpdatedAt']);
  sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  Logger.log('เขียน Target_Rates สำเร็จ: ' + rows.length + ' แถว');
}

// ── ตั้ง trigger รันทุกคืน 02:00 (เรียกครั้งเดียวตอน setup) ──
function setupNightlyTrigger() {
  // ลบ trigger เดิมของฟังก์ชันนี้ก่อน กันซ้ำ
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'computeTargetRates') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('computeTargetRates')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .inTimezone('Asia/Bangkok')
    .create();
  Logger.log('ตั้ง trigger เรียบร้อย: computeTargetRates ทุกคืน 02:00');
}

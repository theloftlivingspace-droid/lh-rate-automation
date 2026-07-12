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

const SHEET_ID = '1XbTJLhecql_HNqyE80Hc6h30A2_elIxliudF4e6Rlz0';
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
// จันทร์-พฤหัส = 1.0, ศุกร์ = 1.15, เสาร์-อาทิตย์ = 1.30
function getDowMult(date) {
  const d = date.getDay(); // 0=Sun ... 6=Sat
  if (d === 0 || d === 6) return 1.30;
  if (d === 5) return 1.15;
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
const OCC_RULES = [
  { max: 10,  mult: 0.55 },
  { max: 20,  mult: 0.65 },
  { max: 35,  mult: 0.78 },
  { max: 50,  mult: 0.88 },
  { max: 65,  mult: 0.95 },
  { max: 75,  mult: 1.00 },
  { max: 85,  mult: 1.10 },
  { max: 92,  mult: 1.20 },
  { max: 101, mult: 1.35 },
];
function getOccMult(occPct) {
  const rule = OCC_RULES.find(r => occPct <= r.max) || OCC_RULES[OCC_RULES.length - 1];
  return rule.mult;
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

  let price = cfg.base * dowMult * seasonMult * occMult * leadMult;
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

  const roomTypeCol = headers.findIndex(h => /room.?type/i.test(h));
  const checkinCol = headers.findIndex(h => /check.?in/i.test(h));
  const checkoutCol = headers.findIndex(h => /check.?out/i.test(h));
  const statusCol = headers.findIndex(h => /status/i.test(h));

  if (roomTypeCol === -1 || checkinCol === -1 || checkoutCol === -1) {
    throw new Error('หา column RoomType/CheckIn/CheckOut ใน Bookings sheet ไม่เจอ — เช็คชื่อ header');
  }

  // นับจำนวนคืนที่ถูกจองต่อห้อง ต่อวัน (booked-night map)
  const bookedNights = {}; // key: "RoomType_YYYY-MM-DD" => count

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[roomTypeCol] || !row[checkinCol] || !row[checkoutCol]) continue;
    if (statusCol !== -1 && /cancel/i.test(String(row[statusCol]))) continue;

    const roomType = normalizeRoomType(String(row[roomTypeCol]));
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
function normalizeRoomType(raw) {
  const s = raw.toLowerCase();
  if (s.includes('lux')) return 'Luxury';
  if (s.includes('retro')) return 'Retro';
  if (s.includes('allure')) return 'Allure';
  if (s.includes('elegance') || s.includes('elegan')) return 'Elegance';
  if (s.includes('legacy')) return 'Legacy';
  if (s.includes('radiance')) return 'Radiance';
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
function computeTargetRates() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('Target_Rates');
  if (!sheet) {
    sheet = ss.insertSheet('Target_Rates');
  }
  sheet.clearContents();
  sheet.appendRow(['Date', 'RoomType', 'Rate', 'Occ%', 'DaysAhead', 'UpdatedAt']);

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

  // เขียนทีเดียวทั้งก้อน (เร็วกว่า appendRow ทีละแถว)
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

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
  Luxury:   { base: 780, min: 450, max: 1800, count: 1 },
  Retro:    { base: 740, min: 400, max: 1500, count: 1 },
  Allure:   { base: 784, min: 500, max: 1400, count: 2 },
  Elegance: { base: 690, min: 360, max: 1300, count: 2 },
  Legacy:   { base: 699, min: 360, max: 1300, count: 2 },
  Radiance: { base: 613, min: 380, max: 1350, count: 2 },
};

// ── DOW multiplier ──
// จันทร์-พฤหัส = 1.0, ศุกร์ = 1.02, เสาร์-อาทิตย์ = 1.09 (ลดช่วงห่างจากวันธรรมดาลงอีก เมื่อ 29 ก.ค. 2026)
function getDowMult(date) {
  const d = date.getDay(); // 0=Sun ... 6=Sat
  if (d === 0 || d === 6) return 1.09;
  if (d === 5) return 1.02;
  return 1.0;
}

// ── วันพิเศษเพิ่มเติม (เทศกาลจันทรคติ/อีเวนต์) — ต้องอัปเดตวันที่ทุกปี เพราะไม่ตรงวันเดิม ──
// เพิ่ม 27 ส.ค. 2026: พบราคาที่ตั้งมือใน LH สูงกว่าปกติมากช่วง 25-27 พ.ย. 2026 (หลังวันลอยกระทงจริง
// 24 พ.ย. 2569) — เพิ่มเป็น peak ในสูตร ให้คำนวณราคาสูงขึ้นเองแทนการชนกับราคาที่ตั้งมือ
// (คู่กับ BLACKOUT_DATES ใน LHRateAutomation.gs ที่กันไม่ให้ push ทับราคามือช่วงนี้อยู่แล้ว)
const SPECIAL_PEAK_RANGES = [
  { start: '2026-11-25', end: '2026-11-27' }, // ลอยกระทง 2569
];
function isSpecialPeakDate(date) {
  const dStr = Utilities.formatDate(date, 'Asia/Bangkok', 'yyyy-MM-dd');
  return SPECIAL_PEAK_RANGES.some(r => dStr >= r.start && dStr <= r.end);
}

// ── Season multiplier ──
const SEASON_MULT = { low: 0.85, normal: 1.0, high: 1.25, peak: 1.5 };
function getSeasonForDate(date) {
  const m = date.getMonth(), d = date.getDate();
  const songkran = m === 3 && d >= 13 && d <= 14;
  const newyear = (m === 11 && d >= 30) || (m === 0 && d <= 2);
  if (songkran || newyear || isSpecialPeakDate(date)) return 'peak';
  if (m >= 10 || m <= 1) return 'high';
  if (m >= 4 && m <= 8) return 'low';
  return 'normal';
}

// ── Occupancy multiplier ──
// อัปเดต 8 ส.ค. 2026: เปลี่ยนจาก step function เป็นเส้นต่อเนื่อง (interpolation) เพราะห้องที่มี 1-2 ห้อง
// occupancy คำนวณจากหน้าต่าง 7 คืน (getWeekOccupancy) ทำให้ occ กระโดดทีละ ~7-14 จุดต่อการจอง 1 ครั้ง
// ถ้าใช้ step function จุดกระโดดของ occ อาจข้าม tier boundary 2 เส้นพร้อมกัน ราคาเลยกระโดดแรงเกินไป
// เส้นต่อเนื่องทำให้ราคาขยับตามสัดส่วน occ จริง ไม่ถูกขยายจากตำแหน่ง tier พอดี
// ช่วง 0.70-0.95 คำนวณจาก floor/base ratio ของแต่ละห้อง (0.63-0.84) กัน curve จมอยู่ใต้ floor
// ตลอดช่วง occ ต่ำ-กลาง (แบบที่ 0.25-0.72 เจอปัญหา) และคุมปลายบนไม่ให้ high/peak season พุ่งเกินไป
// อัปเดต 14 ก.ย. 2026: เดิมปลายบนสุดของ curve คือ 0.95 ที่ occ=100% — แปลว่าต่อให้เต็มห้อง
// ราคาก็ยังต่ำกว่า base เสมอ ไม่มีทางได้ premium เลย พบว่า Legacy occ 98% (ส.ค.)/Retro,Luxury
// occ 100% (ก.ย.) แต่ ADR จริงต่ำกว่า PL Base 40-50% เพราะ mult คุมเพดานไว้ต่ำเกินไป
// เพิ่ม anchor กลางที่ 75% ให้ mult=1.00 (occ ปกติ = ราคา base พอดี ตามหลักการเดิมของสูตร)
// และดันปลายบนที่ 100% เป็น 1.30 ให้ห้องที่เต็ม/เกือบเต็มได้ premium ตามดีมานด์จริง
const OCC_ANCHORS = [
  [0,   0.70],
  [75,  1.00],
  [100, 1.30],
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

// ── Promo: ลดราคาโดยรวม -10% ชั่วคราว ถึงสิ้นเดือน (เปิดใหม่ 27 ส.ค. 2026 เดิมตั้งไว้ถึง 31 ก.ค. 2026) ──
const PROMO_DISC_PCT = 10;
const PROMO_END_DATE = new Date(2026, 8, 30); // 30 ก.ย. 2026 (month index 8 = September)
// อัปเดต 14 ก.ย. 2026: โปรเดิม apply กับทุกห้องเท่ากัน ไม่ว่า demand จะสูงแค่ไหน — พบว่า
// Legacy/Retro/Allure occ 82-100% (ไม่ต้องใช้โปรกระตุ้น) โดนลดราคาซ้อนกับห้องที่ demand
// อ่อนจริง (เช่น Radiance) เพิ่มเงื่อนไข: ห้องที่ occ ปัจจุบัน (หน้าต่าง 7 คืน) >80% ตัดโปรออกทันที
const PROMO_HIGH_OCC_CUTOFF = 80; // % — occ เกินนี้ = ไม่ให้โปร
function getPromoMult(date, occPct) {
  if (occPct != null && occPct > PROMO_HIGH_OCC_CUTOFF) return 1.0;
  const d = new Date(date); d.setHours(0,0,0,0);
  const end = new Date(PROMO_END_DATE); end.setHours(0,0,0,0);
  return d <= end ? 1 - (PROMO_DISC_PCT / 100) : 1.0;
}

// ── Extra promo: ลดเพิ่มอีก -10% ซ้อนกับโปรด้านบน ระยะเวลา 2 สัปดาห์ (29 ส.ค. - 12 ก.ย. 2026) ──
// เพิ่ม 29 ส.ค. 2026 ตามคำขอ — ซ้อนกับ PROMO_DISC_PCT (รวมเป็น -19% ไม่ใช่ -20% เพราะเป็นการคูณ ไม่ใช่บวก)
const EXTRA_PROMO_DISC_PCT = 10;
const EXTRA_PROMO_START_DATE = new Date(2026, 7, 29); // 29 ส.ค. 2026
const EXTRA_PROMO_END_DATE = new Date(2026, 8, 12);   // 12 ก.ย. 2026 (ครบ 2 สัปดาห์)
// อัปเดต 14 ก.ย. 2026: เหตุผลเดียวกับ getPromoMult — ตัดโปรออกสำหรับห้อง occ>80%
function getExtraPromoMult(date, occPct) {
  if (occPct != null && occPct > PROMO_HIGH_OCC_CUTOFF) return 1.0;
  const d = new Date(date); d.setHours(0,0,0,0);
  const start = new Date(EXTRA_PROMO_START_DATE); start.setHours(0,0,0,0);
  const end = new Date(EXTRA_PROMO_END_DATE); end.setHours(0,0,0,0);
  return (d >= start && d <= end) ? 1 - (EXTRA_PROMO_DISC_PCT / 100) : 1.0;
}

// ── Adjustment: ปรับราคาขึ้น +10% จากราคาปัจจุบัน (คูณทับทุก mult อื่นรวมโปรทั้งหมด) ถึงสิ้นเดือน ก.ย. 2026 ──
// เพิ่ม 29 ส.ค. 2026 ตามคำขอ — ใช้กับทุกห้อง คูณต่อจาก promo/extraPromo (ไม่ใช่แทนที่)
const ADJUSTMENT_PCT = 10;
const ADJUSTMENT_START_DATE = new Date(2026, 7, 29); // 29 ส.ค. 2026
const ADJUSTMENT_END_DATE = new Date(2026, 8, 30);   // 30 ก.ย. 2026
function getAdjustmentMult(date) {
  const d = new Date(date); d.setHours(0,0,0,0);
  const start = new Date(ADJUSTMENT_START_DATE); start.setHours(0,0,0,0);
  const end = new Date(ADJUSTMENT_END_DATE); end.setHours(0,0,0,0);
  return (d >= start && d <= end) ? 1 + (ADJUSTMENT_PCT / 100) : 1.0;
}

// ── Lead time discount ──
// อัปเดต 9 ส.ค. 2026: เปลี่ยนจาก step function เป็นเส้นต่อเนื่อง (interpolation) เหมือน occ mult
// เดิม step function ทำให้ราคากระโดดแรงที่ขอบ 7/14/28/45/75 วัน (สูงสุด ~10-12 จุด% ในวันเดียว)
// ค่า mult ที่ anchor แต่ละจุดเท่าเดิมทุกประการ เปลี่ยนแค่ระหว่างจุดให้ไล่ระดับแทนกระโดด
const LEAD_TIME_ANCHORS = [
  [0,  1.18],
  [7,  1.06],
  [14, 0.96],
  [28, 0.91],
  [45, 0.85],
  [75, 0.78],
];

// อัปเดต 8 ก.ย. 2026: เดิม leadMult ดันราคาขึ้นเสมอเมื่อใกล้วันเข้าพัก (daysAhead<=7) ไม่ว่า occupancy
// ของวันนั้นจะต่ำแค่ไหน — ทำให้วันที่ยังขายไม่ออกและใกล้เข้าพักที่สุด (ซึ่งควรเร่งขาย) กลับถูกตั้งราคาสูงสุด
// (+18% ที่ daysAhead=0) จนปิดการขายไม่ได้เลย เพิ่มเงื่อนไข: ถ้าใกล้วันเข้าพัก (<=7 วัน) และ occupancy
// ยังต่ำกว่า LOW_OCC_THRESHOLD ให้ใช้เส้นลดราคาแทนเส้นขึ้นราคาเดิม เพื่อเร่งเติมห้องที่เหลือ
const LOW_OCC_THRESHOLD = 40; // % — ต่ำกว่านี้ถือว่า "ยังขายไม่ออก" ในช่วงใกล้เช็คอิน
const LOW_OCC_LEAD_ANCHORS = [
  [0, 0.80],
  [7, 0.95],
];
function interpolate_(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (x >= x0 && x <= x1) {
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return 1.0;
}
function getLeadMult(daysAhead, occPct) {
  if (daysAhead <= 7 && occPct < LOW_OCC_THRESHOLD) {
    return interpolate_(LOW_OCC_LEAD_ANCHORS, daysAhead);
  }
  return interpolate_(LEAD_TIME_ANCHORS, daysAhead);
}

// ── คำนวณราคาสุดท้าย ──
function calcRate(roomType, date, occPct, daysAhead) {
  const cfg = ROOM_CONFIG[roomType];
  const dowMult = getDowMult(date);
  const season = getSeasonForDate(date);
  const seasonMult = SEASON_MULT[season];
  const occMult = getOccMult(occPct);
  const leadMult = getLeadMult(daysAhead, occPct);
  const promoMult = getPromoMult(date, occPct);
  const extraPromoMult = getExtraPromoMult(date, occPct);
  const adjustmentMult = getAdjustmentMult(date);

  let price = cfg.base * dowMult * seasonMult * occMult * leadMult * promoMult * extraPromoMult * adjustmentMult;
  price = Math.round(price / 50) * 50;

  const floor = Math.round((cfg.min * 1.1) / 50) * 50;
  const ceiling = Math.round((cfg.max * 0.9) / 50) * 50;
  return Math.max(floor, Math.min(ceiling, price));
}

// ── Ramp limiter: จำกัดการเปลี่ยนราคาต่อคืนต่อห้อง/วัน ไม่เกิน RATE_CHANGE_CAP_PCT ──
// เพิ่ม 8 ก.ย. 2026: หลัง fix leadMult ให้ลดราคาแรงเมื่อ occ ต่ำใกล้เช็คอิน พบว่า push บางช่อง
// (เช่น Allure ที่ลดทีเดียว 27-36%) รายงาน POST สำเร็จแต่ verify-GET เจอราคาไม่เปลี่ยน —
// สงสัยว่า LH อาจ silent-reject การเปลี่ยนราคาก้อนใหญ่เกินไปในครั้งเดียว (fat-finger protection)
// เพิ่ม ramp limiter ให้ไล่ระดับเข้าหา target แทนกระโดดทีเดียว โดยเทียบกับราคาที่ตั้งใจไว้ของ
// "คืนก่อนหน้า" สำหรับวันที่เดียวกัน (จาก Target_Rates เดิมก่อนถูกเขียนทับ) — เป็นการดักที่ระดับ
// เจตนา ไม่ใช่ราคาจริงใน LH ณ ขณะนี้ (ซึ่งอาจไม่ตรงกับ Target_Rates เดิมอยู่แล้วถ้ามีคืนไหน push ไม่ติด)
const RATE_CHANGE_CAP_PCT = 15;
function applyRampLimit_(rawTarget, prevRate, cfg) {
  if (prevRate == null || !isFinite(prevRate) || prevRate <= 0) return rawTarget;
  const maxUp = prevRate * (1 + RATE_CHANGE_CAP_PCT / 100);
  const maxDown = prevRate * (1 - RATE_CHANGE_CAP_PCT / 100);
  let capped = Math.max(maxDown, Math.min(maxUp, rawTarget));
  capped = Math.round(capped / 50) * 50;
  const floor = Math.round((cfg.min * 1.1) / 50) * 50;
  const ceiling = Math.round((cfg.max * 0.9) / 50) * 50;
  return Math.max(floor, Math.min(ceiling, capped));
}

// ── อ่านค่า Target_Rates "เดิม" ก่อนจะถูกเขียนทับ ใช้เป็น baseline ของ ramp limiter ──
function readPrevTargetRates_(ss) {
  const prev = {};
  const sheet = ss.getSheetByName('Target_Rates');
  if (!sheet) return prev;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const [dateVal, roomType, rate] = data[i];
    if (!dateVal || !roomType || !rate) continue;
    const dateStr = dateVal instanceof Date
      ? Utilities.formatDate(dateVal, 'Asia/Bangkok', 'yyyy-MM-dd')
      : String(dateVal);
    prev[dateStr + '_' + roomType] = Number(rate);
  }
  return prev;
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

// จำนวนห้องรวมทั้งโรงแรม — ใช้เป็นตัวหารของ occ รวม (baseline ที่นิ่ง สำหรับ credibility blend ด้านล่าง)
const TOTAL_ROOM_COUNT = Object.values(ROOM_CONFIG).reduce((sum, c) => sum + c.count, 0);

// นับคืนที่ถูกจองรวมทุกห้องทุกประเภท ในหน้าต่าง 7 คืนรอบวันที่กำหนด (ใช้คำนวณ occ รวมโรงแรม)
function getWeekNightsAllRooms_(date, bookedNights) {
  const windowStart = new Date(date);
  windowStart.setDate(date.getDate() - 3);
  let nights = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(windowStart);
    d.setDate(windowStart.getDate() + i);
    const dStr = Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
    Object.keys(ROOM_CONFIG).forEach(rt => {
      nights += bookedNights[rt + '_' + dStr] || 0;
    });
  }
  return nights;
}

// occupancy ของหน้าต่าง 7 คืน "รอบวันที่กำหนด" (rolling window, ±3 วัน) เป็น %
// อัปเดต 9 ส.ค. 2026: เดิมใช้สัปดาห์ปฏิทินตายตัว (จันทร์-อาทิตย์) ทำให้ occ% รีเซ็ตคำนวณใหม่
// ทั้งก้อนทันทีที่ข้ามจากอาทิตย์ไปจันทร์ — ห้องที่มีแค่ 1 ห้อง (capacity 7 room-nights/สัปดาห์)
// โดนหนักสุด เพราะการจอง 1-2 คืนหลุดจากหน้าต่างทำให้ occ กระโดด 15-30 จุดในคืนเดียว ราคาจึงกระโดดตาม
// เปลี่ยนเป็นหน้าต่างเลื่อนตามวันที่ (rolling) แทน ทำให้ occ% ไล่ระดับต่อเนื่องวันต่อวัน ไม่มีขอบสัปดาห์ให้กระโดด
//
// อัปเดต 14 ก.ย. 2026: ห้อง 1 ห้อง (Luxury/Retro) ยัง noise สูงอยู่ดีแม้ใช้ rolling window แล้ว
// เพราะ capacity ในหน้าต่าง (7 room-nights) เล็ก — จอง/ยกเลิก 1 คืน = occ กระโดด ~14 จุด%
// เพิ่ม credibility-weighted blend: ผสม occ เฉพาะห้องประเภทนั้น กับ occ รวมทั้งโรงแรม (นิ่งกว่ามาก
// เพราะ capacity ใหญ่กว่า ~7-10 เท่า) โดยน้ำหนักขึ้นกับ capacity ของห้องประเภทนั้นเอง —
// ห้องยิ่งน้อย ยิ่งเชื่อ occ รวมโรงแรมมากขึ้น (แทนที่จะเชื่อ noise ของตัวเอง 100%)
const OCC_CREDIBILITY_K = 14; // room-nights — ห้องที่ capacity เท่านี้จะเชื่อ occ ตัวเอง/รวม อย่างละครึ่ง
function getWeekOccupancy(roomType, date, bookedNights) {
  const cfg = ROOM_CONFIG[roomType];
  const windowStart = new Date(date);
  windowStart.setDate(date.getDate() - 3); // ±3 วันรอบวันที่กำหนด = หน้าต่าง 7 วัน

  let nights = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(windowStart);
    d.setDate(windowStart.getDate() + i);
    const key = roomType + '_' + Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
    nights += bookedNights[key] || 0;
  }
  const capacity = 7 * cfg.count;
  const ownOcc = capacity > 0 ? (nights / capacity) * 100 : 0;

  const propertyNights = getWeekNightsAllRooms_(date, bookedNights);
  const propertyCapacity = 7 * TOTAL_ROOM_COUNT;
  const propertyOcc = propertyCapacity > 0 ? (propertyNights / propertyCapacity) * 100 : 0;

  const w = capacity / (capacity + OCC_CREDIBILITY_K);
  const blended = w * ownOcc + (1 - w) * propertyOcc;
  return Math.round(blended);
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

  // ── อ่าน Target_Rates เดิม (ก่อนเขียนทับ) ไว้เป็น baseline ของ ramp limiter ──
  const outputSs = SpreadsheetApp.openById(OUTPUT_SHEET_ID);
  const prevRates = readPrevTargetRates_(outputSs);

  const rows = [];
  const now = new Date().toISOString();

  for (let dOffset = 0; dOffset <= DAYS_AHEAD_TO_COMPUTE; dOffset++) {
    const date = new Date(today);
    date.setDate(today.getDate() + dOffset);
    const dateStr = Utilities.formatDate(date, 'Asia/Bangkok', 'yyyy-MM-dd');

    Object.keys(ROOM_CONFIG).forEach(roomType => {
      const occ = getWeekOccupancy(roomType, date, bookedNights);
      const rawRate = calcRate(roomType, date, occ, dOffset);
      const prevRate = prevRates[dateStr + '_' + roomType];
      const rate = applyRampLimit_(rawRate, prevRate, ROOM_CONFIG[roomType]);
      rows.push([
        dateStr,
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
  let sheet = outputSs.getSheetByName('Target_Rates');
  if (!sheet) {
    sheet = outputSs.insertSheet('Target_Rates');
  }
  sheet.clearContents();
  sheet.appendRow(['Date', 'RoomType', 'Rate', 'Occ%', 'DaysAhead', 'UpdatedAt']);
  sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  Logger.log('เขียน Target_Rates สำเร็จ: ' + rows.length + ' แถว (ramp limiter cap=' + RATE_CHANGE_CAP_PCT + '%)');
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

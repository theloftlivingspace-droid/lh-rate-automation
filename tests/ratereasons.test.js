// รัน: node tests/ratereasons.test.js — คำอธิบายราคาต้องตรงกับสูตรจริง (calcRate) และไม่แตะ logic ราคา
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const rd = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
// ปิด RAMP_BYPASS_DATE (สวิตช์ข้าม ramp รายวัน) ในเทสต์ — ไม่งั้นผลเปลี่ยนตามวันที่รัน
const code = rd('computeTargetRates.gs').replace(/const RAMP_BYPASS_DATE = '[^']*'/, "const RAMP_BYPASS_DATE = ''") + '\n' + rd('RateReasons.gs') +
  '\n;({ readRateReasons_, explainRate_, buildRateReasonRow_, rateFactors_, rateUnclamped_, calcRate, applyRampLimit_, ROOM_CONFIG })';
const pad = n => String(n).padStart(2, '0');
const sandbox = {
  FAKE: [],
  TARGET: null,
  SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => {
    const v = n === 'Rate_Reasons' ? sandbox.FAKE : n === 'Target_Rates' ? sandbox.TARGET : null;
    return v ? { getDataRange: () => ({ getValues: () => v }) } : null;
  } }) },
  Logger: { log() {} },
  Utilities: { formatDate: (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) },
  console,
};
const X = vm.runInNewContext(code, sandbox);

// 1) คำอธิบายต้องสร้างราคาเดิมได้เป๊ะ: unclamped → ชนพื้น/เพดาน = calcRate
let checked = 0;
for (const room of Object.keys(X.ROOM_CONFIG)) {
  const cfg = X.ROOM_CONFIG[room];
  const floor = Math.round((cfg.min * 1.1) / 50) * 50, ceil = Math.round((cfg.max * 0.9) / 50) * 50;
  for (let d = 0; d < 120; d += 7) {
    for (const occ of [0, 30, 60, 75, 90, 100]) {
      const date = new Date(2026, 10, 21 + d);
      const ahead = d;
      const f = X.rateFactors_(room, date, occ, ahead);
      const un = X.rateUnclamped_(room, f);
      assert.strictEqual(Math.max(floor, Math.min(ceil, un)), X.calcRate(room, date, occ, ahead), `${room} d=${d} occ=${occ}`);
      checked++;
    }
  }
}
// 2) ข้อความ: มีราคา ฐาน ปัจจัยหลัก
const sun = new Date(2026, 11, 20); // อาทิตย์
const e = X.explainRate_('Allure', sun, 90, 30, 1200, null, 1200, '2026-12-20');
assert.ok(e.factors.some(f => f.key === 'dow'), 'ต้องมีปัจจัยวัน');
assert.ok(/฿1200/.test(e.reason) && /ปัจจัยหลัก/.test(e.reason), e.reason);
// 3) ramp limit ต้องบอกเหตุผล
const cfg = X.ROOM_CONFIG.Allure, ramped = X.applyRampLimit_(1400, 1000, cfg);
assert.ok(ramped < 1400);
assert.ok(/ทีละไม่เกิน 15%/.test(X.explainRate_('Allure', sun, 90, 30, 1400, 1000, ramped, '2026-12-20').reason));
// 4) แถวที่เขียนลงชีตมี 9 คอลัมน์ และ Factors เป็น JSON
const row = X.buildRateReasonRow_('2026-12-20', 'Allure', sun, 90, 30, 1200, 1100, 1150, 'now');
assert.strictEqual(row.length, 9); assert.ok(Array.isArray(JSON.parse(row[7])));
// 5) ไม่แตะสูตรราคา: calcRate ยังมี product เดิมครบทุกตัว
assert.ok(/base \* dowMult \* seasonMult \* occMult \* leadMult \* promoMult \* extraPromoMult \* adjustmentMult \* floodMult/.test(rd('computeTargetRates.gs')));
console.log('rate reasons tests OK (' + checked + ' ชุดเทียบสูตร)');

// 6) readRateReasons_: กรองช่วงวันที่/ห้อง, แปลง Date ของ Sheets, ข้ามแถวเสีย, จำกัดผลลัพธ์
{
  const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b)); // ผลจาก vm คนละ realm เทียบผ่าน JSON
  const hdr = ['Date', 'RoomType', 'Rate', 'PrevRate', 'RawRate', 'Base', 'Reason', 'Factors', 'UpdatedAt'];
  const f = JSON.stringify([{ key: 'dow', label: 'วันเสาร์', mult: 1.09 }]);
  sandbox.FAKE = [hdr,
    ['2026-11-22', 'Allure', 1100, 1000, 1150, 941, 'เหตุผล A', f, 'now'],
    [vm.runInContext('new Date(2026, 10, 21)', sandbox), 'Retro', 1200, '', 1200, 962, 'เหตุผล B', 'ไม่ใช่json', 'now'],  // Date จาก Sheets + factors เสีย
    ['ไม่ใช่วันที่', 'Retro', 1, 1, 1, 1, 'x', '[]', 'now'],                                   // แถวเสีย ต้องข้าม
    ['2026-12-30', 'Allure', 1500, 1400, 1500, 941, 'เหตุผล C', '[]', 'now']];
  let r = X.readRateReasons_({});
  assert.strictEqual(r.ok, true); assert.strictEqual(r.rows.length, 3);
  same(r.rows.map(x => x.date), ['2026-11-21', '2026-11-22', '2026-12-30']); // เรียงตามวันที่ + แปลง Date
  assert.strictEqual(r.rows[0].prev, null); same(r.rows[0].factors, []);
  assert.strictEqual(r.rows[1].factors[0].mult, 1.09);
  r = X.readRateReasons_({ from: '2026-11-22', to: '2026-11-30', room: 'Allure' });
  same(r.rows.map(x => x.reason), ['เหตุผล A']);
  assert.strictEqual(X.readRateReasons_({ from: 'drop table' }).rows.length, 3); // from เสีย = ไม่กรอง ไม่ error
  sandbox.FAKE = [hdr].concat(Array.from({ length: 500 }, (_, i) => ['2026-11-22', 'Allure', 1000 + i, '', 1000, 941, 'r', '[]', 'now']));
  assert.strictEqual(X.readRateReasons_({}).rows.length, 400);
}
// 7) ทางสำรอง: ยังไม่มี Rate_Reasons → อธิบายจาก Target_Rates ปัจจุบันทันที
{
  const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  const hdr = ['Date', 'RoomType', 'Rate', 'Occ%', 'DaysAhead', 'UpdatedAt'];
  const date = new Date(2026, 11, 20);
  const rawA = X.calcRate('Allure', date, 90, 29);
  sandbox.FAKE = [];                                  // Rate_Reasons ว่าง/ไม่มี
  sandbox.TARGET = [hdr,
    ['2026-12-20', 'Allure', rawA, 90, 29, 'T1'],      // ตรงเป้า
    [vm.runInContext('new Date(2026, 11, 21)', sandbox), 'Retro', 50, 40, 30, 'T1'], // Date จาก Sheets + ราคาต่ำกว่าเป้า
    ['2026-12-22', 'ห้องไม่มีจริง', 1000, 50, 31, 'T1'], // ประเภทห้องไม่รู้จัก ต้องข้าม
    ['2026-12-23', 'Allure', 'abc', 50, 32, 'T1']];     // ราคาเสีย ต้องข้าม
  let r = X.readRateReasons_({});
  assert.strictEqual(r.ok, true); assert.strictEqual(r.source, 'target_rates'); assert.ok(r.note);
  same(r.rows.map(x => x.date + x.room), ['2026-12-20Allure', '2026-12-21Retro']);
  assert.ok(new RegExp('฿' + rawA).test(r.rows[0].reason) && r.rows[0].reason.indexOf('ยังไม่ถึงราคาเป้า') < 0);
  assert.ok(r.rows[1].reason.indexOf('ยังไม่ถึงราคาเป้า') >= 0);
  assert.strictEqual(r.rows[0].prev, null);
  r = X.readRateReasons_({ from: '2026-12-21', room: 'Retro' });
  same(r.rows.map(x => x.room), ['Retro']);
  sandbox.TARGET = null;
  r = X.readRateReasons_({}); assert.strictEqual(r.ok, true); assert.strictEqual(r.rows.length, 0); assert.ok(r.note);
  // Rate_Reasons มีข้อมูล → ใช้ของที่บันทึกไว้ ไม่ใช่ทางสำรอง
  sandbox.FAKE = [['Date'], ['2026-11-22', 'Allure', 1100, 1000, 1150, 941, 'เหตุผลที่บันทึกไว้', '[]', 'now']];
  r = X.readRateReasons_({}); assert.strictEqual(r.source, undefined); assert.strictEqual(r.rows[0].reason, 'เหตุผลที่บันทึกไว้');
}
console.log('read rate reasons tests OK');

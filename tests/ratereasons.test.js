// รัน: node tests/ratereasons.test.js — คำอธิบายราคาต้องตรงกับสูตรจริง (calcRate) และไม่แตะ logic ราคา
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const rd = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const code = rd('computeTargetRates.gs') + '\n' + rd('RateReasons.gs') +
  '\n;({ explainRate_, buildRateReasonRow_, rateFactors_, rateUnclamped_, calcRate, applyRampLimit_, ROOM_CONFIG })';
const X = vm.runInNewContext(code, { Logger: { log() {} }, Utilities: { formatDate: (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }, SpreadsheetApp: {}, console });

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

// รัน: node tests/manualhold.test.js — ตรวจช่วงกันราคามือ (MANUAL_HOLD_RANGES) และว่า pushOnePage เรียกใช้จริง
const fs=require('fs'), assert=require('assert');
const src=fs.readFileSync(require('path').join(__dirname,'..','src','LHRateAutomation.gs'),'utf8');
const m=src.match(/const MANUAL_HOLD_RANGES[\s\S]*?function isManualHold_\([\s\S]*?\n}\n/);
assert.ok(m,'ไม่พบ MANUAL_HOLD_RANGES/isManualHold_');
const isHold=new Function(m[0].replace('const MANUAL_HOLD_RANGES','var MANUAL_HOLD_RANGES')+'; return isManualHold_;')();
['2026-11-01','2026-11-19','2026-12-24','2026-12-31'].forEach(d=>assert.strictEqual(isHold(d),true,d));
['2026-10-31','2027-01-01','2027-01-15','2027-02-17'].forEach(d=>assert.strictEqual(isHold(d),false,d));
assert.ok(/BLACKOUT_DATES\.has\(dateStr\)\s*\|\|\s*isManualHold_\(dateStr\)/.test(src),'pushOnePage ไม่ได้เรียก isManualHold_');
console.log('manual hold tests OK');

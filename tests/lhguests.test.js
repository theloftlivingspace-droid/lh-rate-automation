// รัน: node tests/lhguests.test.js  — mock Sheets/LH ทั้งหมด (fixture สังเคราะห์ตามโครงสร้างหน้า Reservations จริง)
const fs = require('fs'), path = require('path'), assert = require('assert');
let sheetValues, written, nextPages, urls, hour = 14, server = null, logs = [];
global.LH_BASE_URL = 'https://x'; global.LH_PROPERTY_ID = '14501'; global.SHEET_ID = 'sid';
global.Logger = { log(m) { logs.push(String(m)); } };
global.Utilities = {
  sleep() {},
  formatDate(d, tz, f) { // พอสำหรับที่ใช้ในโค้ด (เขตเวลา +07:00)
    const t = new Date(d.getTime() + 7 * 3600 * 1000), iso = t.toISOString();
    if (f === 'yyyy-MM-dd') return iso.slice(0, 10);
    if (f === 'dd MMM yyyy') return iso.slice(8, 10) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][t.getUTCMonth()] + ' ' + iso.slice(0, 4);
    throw new Error('fmt ' + f);
  },
};
global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) };
global.lhFetch_ = (url) => { urls.push(url); const p = server ? server(url) : nextPages.shift(); return { getResponseCode: () => p.code, getContentText: () => p.html }; };
global.SpreadsheetApp = { openById: () => ({ getSheetByName: () => ({
  getDataRange: () => ({ getValues: () => sheetValues.map(r => r.slice()) }),
  getRange: (r, c, nr, nc) => ({
    getValue: () => sheetValues[r - 1][c - 1],
    getValues: () => [sheetValues[r - 1].slice(c - 1, c - 1 + (nc || 1))],
    setValue: (v) => { while (sheetValues[r - 1].length < c) sheetValues[r - 1].push(''); sheetValues[r - 1][c - 1] = v; written.push([r, c, v]); },
  }),
}) }) };
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'LHGuests.gs'), 'utf8');
eval(src.replace(/^const /gm, 'global.').replace(/^function (\w+)/gm, 'global.$1 = function'));

const row = (status, name, ref, a, c, p, ci, room) => `<tr class='reservation_room_type'><td class='status'><span class='confirmed'>${status}</span></td><td class='name unread'><span class='maskContent'>${name}</span></td><td class='booking-reference unread'><a target="_blank" class="booking-reference" href="/x">${ref}</a></td><td class='booking_source'><span>Airbnb</span></td><td class='guests center'><span><div class='fa fa-user mute'></div> ${a}</span><span><div class='fa fa-child mute'></div> ${c}</span><span><div class='fa fa-pram mute'></div> ${p}</span></td><td class='check_in'>${ci}</td><td class='check_out'>20-12-26</td><td class='room_name'> ${room} </td></tr>`;
const page = (rows, found) => `<h4> ${found === undefined ? rows.length : found} Reservations Found </h4><table><tbody>${rows.join('')}</tbody></table>`;
const HDR8 = ['เลขห้อง', 'ชื่อแขก', 'เช็คอิน', 'เช็คเอาท์', 'Channel', 'ResId', 'Note', 'วันจอง'];
const HDR = HDR8.concat(['Adults', 'Children', 'Guests']);
const reset = (rows, hdr) => { sheetValues = [(hdr || HDR).slice()].concat(rows); written = []; urls = []; nextPages = []; };
const ok = (html) => ({ code: 200, html });

// parse: ผู้ใหญ่/เด็ก/ทารก, ทารกรวมในเด็ก
let p = lhParseReservations_(page([row('Confirmed', 'Smith, Anna', 'ABB-1', 2, 1, 1, '16-10-26', '209 Radiance')]));
assert.strictEqual(p.found, 1); assert.deepStrictEqual([p.rows[0].adults, p.rows[0].children, p.rows[0].checkIn], [2, 2, '2026-10-16']);
assert.strictEqual(lhParseReservations_('<html>sign in</html>').found, null);

// sync: เติมเฉพาะแถวว่าง / ไม่ทับ / ข้ามยกเลิก+อดีต / ชื่อกลับลำดับ
reset([
  ['209 Radiance', 'Anna Smith', '2026-12-16', '2026-12-20', 'Airbnb', 'R1', '', ''],            // ต้องเติม
  ['210 Radiance', 'Bob Jones', '2026-12-16', '2026-12-20', 'Airbnb', 'R2', '', '', 3, 0, 3], // มีค่าแล้ว (แอดมินกรอก) ห้ามทับ
  ['103 Elegance cancel', 'Cy Cancel', '2026-12-16', '2026-12-20', 'Airbnb', 'R3', '', ''],     // ยกเลิก
  ['108 Retro', 'Old Guest', '2020-01-01', '2020-01-03', 'Airbnb', 'R4', '', ''],                // อดีต
  ['300 Luxury', 'Zed Unknown', '2026-12-16', '2026-12-20', 'Airbnb', 'R5', '', ''],            // LH ไม่มีคู่
]);
global.Date = class extends Date { constructor(...a) { if (!a.length) super('2026-12-10T05:00:00Z'); else super(...a); } static now() { return new Date('2026-12-10T05:00:00Z').getTime(); } };
nextPages = [ok(page([row('Confirmed', 'Smith, Anna', 'ABB-1', 2, 1, 0, '16-12-26', '209 Radiance'), row('Confirmed', 'Jones, Bob', 'ABB-2', 9, 9, 0, '16-12-26', '210 Radiance')]))];
let r = syncGuestCountsFromLH_();
assert.deepStrictEqual(r, { needed: 2, updated: 1, unmatched: 1 });
const ws = written.map(w => w.join(':'));
assert.deepStrictEqual(ws.slice(-3), ['2:9:2', '2:10:1', '2:11:3']); // แถว 2 → Adults/Children/Guests
assert.ok(!written.some(w => w[0] === 3), 'ห้ามทับแถวที่มีค่าแล้ว');
assert.ok(/date_from%5D=2026-11-16/.test(urls[0]) && /status%5D=(&|$)/.test(urls[0]) && /properties\/14501\/reservations/.test(urls[0]));

// ยังไม่มีคอลัมน์ Adults/Children/Guests → สร้างหัวคอลัมน์ให้แล้วเติม
reset([['209 Radiance', 'Anna Smith', '2026-12-16', '2026-12-20', 'Airbnb', 'R1', '', '']], HDR8);
nextPages = [ok(page([row('Confirmed', 'Smith, Anna', 'ABB-1', 2, 0, 0, '16-12-26', '209 Radiance')]))];
r = syncGuestCountsFromLH_(); assert.strictEqual(r.updated, 1);
assert.deepStrictEqual(sheetValues[0].slice(8), ['Adults', 'Children', 'Guests']); assert.deepStrictEqual(sheetValues[1].slice(8), [2, 0, 2]);

// หมดอายุ/หน้า login → ไม่เขียนอะไรเลย
reset([['209 Radiance', 'Anna Smith', '2026-12-16', '2026-12-20', 'Airbnb', 'R1', '', '']]);
nextPages = [ok('<html>sign in</html>')]; r = syncGuestCountsFromLH_();
assert.strictEqual(r.aborted, 'expired'); assert.strictEqual(written.length, 0);
// LH ล่ม 503 → ไม่เขียน
reset([['209 Radiance', 'Anna Smith', '2026-12-16', '2026-12-20', 'Airbnb', 'R1', '', '']]);
nextPages = [{ code: 503, html: '' }]; r = syncGuestCountsFromLH_(); assert.strictEqual(r.aborted, 'transient'); assert.strictEqual(written.length, 0);

// จองหลายห้อง ชื่อเดียวกัน จำนวนต่างกัน → แยกด้วยเลขห้อง; ไม่มีเลขห้องให้แยก → ไม่เดา
const multi = [row('Confirmed', 'Lee, Kim', 'A', 2, 0, 0, '16-12-26', '203 Allure'), row('Confirmed', 'Lee, Kim', 'B', 1, 1, 0, '16-12-26', '204 Retro')];
const mp = lhParseReservations_(page(multi)).rows;
assert.deepStrictEqual(lhMatchGuests_({ name: 'Kim Lee', checkIn: '2026-12-16', room: '204 Retro' }, mp), { adults: 1, children: 1 });
assert.strictEqual(lhMatchGuests_({ name: 'Kim Lee', checkIn: '2026-12-16', room: 'รอยืนยัน' }, mp), null);
// ชื่อสั้นเกิน (1 token) ไม่ใช้ subset
assert.strictEqual(lhMatchGuests_({ name: 'Anna', checkIn: '2026-12-16', room: '1' }, lhParseReservations_(page([row('Confirmed', 'Smith, Anna', 'X', 2, 0, 0, '16-12-26', '1')])).rows), null);

// ---- mock ที่ตอบตามช่วงวันที่ใน URL (ไม่พึ่งลำดับคำขอ) ----
const isoOf = (ci) => '20' + ci.slice(6, 8) + '-' + ci.slice(3, 5) + '-' + ci.slice(0, 2);
const serveFrom = (defs, lie) => (url) => {
  const f = url.match(/date_from%5D=(\d{4}-\d\d-\d\d)/)[1], t = url.match(/date_to%5D=(\d{4}-\d\d-\d\d)/)[1];
  const inRange = defs.filter(d => isoOf(d[6]) >= f && isoOf(d[6]) <= t);
  const wide = (new Date(t) - new Date(f)) / 86400000 > 7;
  return ok(page(inRange.map(d => row(...d)), lie && wide ? inRange.length + 1 : undefined));
};

// แบ่งช่วงวันเมื่อ LH บอกจำนวนไม่ตรงกับแถวที่อ่านได้ (แบ่งหน้า) — ต้องยังได้ครบ
reset([['209 Radiance', 'Anna Smith', '2026-12-01', '2026-12-20', 'Airbnb', 'R1', '', ''], ['210 Radiance', 'Bob Jones', '2026-12-30', '2026-12-31', 'Airbnb', 'R2', '', '']]);
server = serveFrom([['Confirmed', 'Smith, Anna', 'A', 1, 0, 0, '01-12-26', '209'], ['Confirmed', 'Jones, Bob', 'B', 2, 0, 0, '30-12-26', '210']], true);
r = syncGuestCountsFromLH_(); assert.strictEqual(r.updated, 2); assert.ok(urls.length >= 3);

// แถวที่ถูกแยกจากการย้ายห้อง (ช่วงต่อ -B ใช้วันย้ายเป็นเช็คอิน): LH เช็คอิน 10-12 ออก 20-12, ชีตช่วงต่อเช็คอิน 15-12
reset([['305 Luxury', 'Anna Smith', '2026-12-15', '2026-12-20', 'Airbnb', 'R1-B', '', '']]);
server = serveFrom([['Confirmed', 'Smith, Anna', 'ABB-9', 2, 1, 0, '10-12-26', '209 Radiance']]);
logs = []; r = syncGuestCountsFromLH_();
assert.deepStrictEqual(r, { needed: 1, updated: 1, unmatched: 0 }); assert.deepStrictEqual(sheetValues[1].slice(8), [2, 1, 3]);
assert.ok(/date_from%5D=2026-11-15/.test(urls[0]), 'ต้องดึงย้อนหลังเพื่อเจอการจองเดิม');
// เช็คอินอยู่นอกช่วงการเข้าพัก (ก่อนเช็คอิน LH / ตรงวันเช็คเอาท์) → ห้ามจับคู่
for (const ci of ['2026-12-09', '2026-12-20']) {
  reset([['305 Luxury', 'Anna Smith', ci, '2026-12-25', 'Airbnb', 'R1-B', '', '']]);
  server = serveFrom([['Confirmed', 'Smith, Anna', 'ABB-9', 2, 1, 0, '10-12-26', '209 Radiance']]);
  r = syncGuestCountsFromLH_(); assert.strictEqual(r.updated, 0, 'ไม่ควรจับคู่ ' + ci);
}
// ยกเลิกไม่ถูกนำมาจับคู่ + แถวที่ยังจับไม่ได้ต้องมีล็อกอธิบายสาเหตุ
reset([['209 Radiance', 'Anna Smith', '2026-12-21', '2026-12-25', 'Airbnb', 'R1', '', ''], ['300 Luxury', 'Ghost Guest', '2026-12-21', '2026-12-25', 'Airbnb', 'R2', '', '']]);
server = serveFrom([['Cancelled', 'Smith, Anna', 'ABB-1', 5, 0, 0, '21-12-26', '209 Radiance'], ['Confirmed', 'Smith, Anna', 'ABB-3', 2, 0, 0, '01-12-26', '209 Radiance']]);
logs = []; r = syncGuestCountsFromLH_();
assert.strictEqual(r.updated, 0); // ยกเลิกถูกตัด + การจอง 01-12→20-12 ไม่ครอบคลุมวันที่ 21
assert.ok(logs.some(l => /Ghost Guest/.test(l) && /ไม่มีการจองชื่อนี้/.test(l)), 'ต้องบอกว่า LH ไม่มีชื่อนี้');
assert.ok(logs.some(l => /Anna Smith/.test(l) && /ไม่ตรงเงื่อนไข/.test(l) && /2026-12-01/.test(l)), 'ต้องบอกวันที่ที่ LH มีชื่อนี้');
server = null;

// สำเนียง: LH "Rudavičius, Andrius" ↔ ชีต "Andrius Rudavičius" (precomposed/decomposed/ตัดสำเนียง)
{
  const lh = lhParseReservations_(page([row('Confirmed', 'Rudavi\u010dius, Andrius', 'ABB-X', 1, 0, 0, '16-10-26', '209 Radiance')])).rows;
  for (const nm of ['Andrius Rudavi\u010dius', 'Andrius Rudavic\u030cius', 'Andrius Rudavicius']) {
    assert.deepStrictEqual(lhMatchGuests_({ name: nm, checkIn: '2026-10-16', room: '209 Radiance' }, lh), { adults: 1, children: 0 });
  }
}
// สถานะอื่น (เช็คอินแล้ว/Direct) ใช้ได้ แต่ Cancelled/No show ห้ามเอามาจับคู่
{
  const rows = lhParseReservations_(page([row('Checked In', 'Harasawa, Ryo', 'DBK-1', 2, 0, 0, '12-10-26', '113 Legacy'), row('Cancelled', 'Harasawa, Ryo', 'DBK-0', 9, 9, 0, '12-10-26', '113 Legacy')])).rows;
  assert.deepStrictEqual(lhMatchGuests_({ name: 'RYO HARASAWA', checkIn: '2026-10-12', room: '113 Legacy' }, rows), { adults: 2, children: 0 });
  assert.strictEqual(lhMatchGuests_({ name: 'RYO HARASAWA', checkIn: '2026-10-12', room: '113' }, rows.slice(1)), null);
}
console.log('LHGuests tests OK');

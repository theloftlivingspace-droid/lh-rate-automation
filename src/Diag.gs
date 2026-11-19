/**
 * Diag.gs — ชั่วคราว: ตรวจว่าโครงสร้างหน้า inventory ของ LH (หลังเปลี่ยนเป็น UUID) ยังเข้ากับตัวแยกวิเคราะห์เดิมไหม
 * รันมือใน editor: diagLhSession() — ไม่ POST ไม่แก้อะไร ไม่ log ค่าคุกกี้/token (log แค่สถานะ โครงสร้าง และ ID ของห้อง)
 * ลบไฟล์นี้หลังใช้เสร็จ
 */
function diagLhSession() {
  const cookie = PropertiesService.getScriptProperties().getProperty('LH_SESSION_COOKIE');
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const url = LH_BASE_URL + '/extranet/properties/' + LH_PROPERTY_ID + '/inventory/edit?start_date=' + today + '&viewable_fields=detailed';
  const r = UrlFetchApp.fetch(url, {
    method: 'get', followRedirects: false, muteHttpExceptions: true,
    headers: { Cookie: LH_COOKIE_NAME + '=' + cookie },
  });
  const html = r.getContentText();
  const out = {
    code: r.getResponseCode(),
    hasMarker: html.indexOf(LH_AUTH_MARKER) !== -1,
    exactFormAction: html.indexOf('action="/extranet/properties/' + LH_PROPERTY_ID + '/inventory"') !== -1,
    formActions: (html.match(/action="\/extranet\/properties\/[^"]*"/g) || []).slice(0, 8),
    hasAuthToken: /name="authenticity_token"\s+value="[^"]+"/.test(html),
    ratePlanInputs: (html.match(/name="rate_plan_dates\[[^\]]+\]\[rate\]"/g) || []).length,
    sampleRateField: (html.match(/name="rate_plan_dates\[[^\]]+\]\[rate\]"/) || [])[0] || null,
    anchorSamples: [],
    rooms: [],
    parseError: null,
  };
  const seen = {};
  (html.match(/room_types\/[^\/"]+\/rate_plans\/[^\/"]+\/edit/g) || []).forEach(a => { if (!seen[a]) { seen[a] = 1; if (out.anchorSamples.length < 6) out.anchorSamples.push(a); } });
  try { parseFormFields(html); } catch (e) { out.parseError = String(e); }
  Object.keys(ROOM_LH_MAP).forEach(room => {
    const m = ROOM_LH_MAP[room];
    let ids = null; try { ids = extractRateIdsForRoom(html, m.roomTypeId, m.ratePlanId); } catch (e) {}
    out.rooms.push(room + ':' + (ids ? ids.length : 'none'));
  });
  Logger.log(JSON.stringify(out));
}

/**
 * สรุปขนาดความต่างใน Rate_Diff_Check (อ่านอย่างเดียว ไม่แก้ชีต) — รันหลัง diffRatesVsLH
 * รันมือ: summarizeRateDiff()  (ลบพร้อมไฟล์นี้หลังใช้เสร็จ)
 */
function summarizeRateDiff() {
  const sh = SpreadsheetApp.openById(LH_SHEET_ID).getSheetByName('Rate_Diff_Check');
  const rows = sh.getDataRange().getValues().slice(1).filter(r => r[1] && typeof r[3] === 'number');
  const items = rows.map(r => {
    const cur = (typeof r[2] === 'number' && r[2] > 0) ? r[2] : null;
    const d = r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Bangkok', 'yyyy-MM-dd') : String(r[0]);
    return { date: d, room: r[1], cur: cur, tgt: r[3], pct: cur ? Math.round((r[3] / cur - 1) * 1000) / 10 : null };
  });
  const withPct = items.filter(i => i.pct !== null).sort((a, b) => a.pct - b.pct);
  const fmt = i => i.room + ' ' + i.date + ': ' + i.cur + '→' + i.tgt + ' (' + i.pct + '%)';
  const byRoom = {};
  items.forEach(i => {
    const b = byRoom[i.room] = byRoom[i.room] || { n: 0, up: 0, down: 0, sumPct: 0, np: 0 };
    b.n++; if (i.pct !== null) { b.np++; b.sumPct += i.pct; if (i.pct > 0) b.up++; else if (i.pct < 0) b.down++; }
  });
  Object.keys(byRoom).forEach(k => { const b = byRoom[k]; b.avgPct = b.np ? Math.round(b.sumPct / b.np * 10) / 10 : null; delete b.sumPct; delete b.np; });
  const dates = items.map(i => i.date).sort();
  Logger.log(JSON.stringify({
    total: items.length,
    noCurrent: items.length - withPct.length,
    over15: withPct.filter(i => Math.abs(i.pct) > 15).length,
    over30: withPct.filter(i => Math.abs(i.pct) > 30).length,
    over50: withPct.filter(i => Math.abs(i.pct) > 50).length,
    medianPct: withPct.length ? withPct[Math.floor(withPct.length / 2)].pct : null,
    dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
    biggestDrops: withPct.slice(0, 5).map(fmt),
    biggestRises: withPct.slice(-5).reverse().map(fmt),
    byRoom: byRoom,
  }));
}

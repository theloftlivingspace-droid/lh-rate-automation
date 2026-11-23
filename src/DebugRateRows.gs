// ── DEBUG (อ่านอย่างเดียว ไม่เขียนอะไรเข้า LH/ชีต) ──
// เทียบแถวราคาที่สคริปต์อ่านจริงใน LH กับ Target_Rates สำหรับ 14 วันแรกของหน้า
// วิธีใช้: รัน debugRateRows() จาก editor แล้วดู log
// เพิ่ม 23 พ.ย. 2026: ตรวจกรณีหน้า LH แสดงราคาไม่ตรง แต่ diffRatesVsLH รายงาน 0 ช่อง
function debugRateRows(startDate) {
  const start = startDate || '2026-11-22';
  const cookie = PropertiesService.getScriptProperties().getProperty('LH_SESSION_COOKIE');
  const url = `${LH_BASE_URL}/extranet/properties/${LH_PROPERTY_ID}/inventory/edit?start_date=${start}&viewable_fields=detailed`;
  const resp = lhFetch_(url, {
    method: 'get',
    headers: { Cookie: `_littlehotelier_session=${cookie}` },
    muteHttpExceptions: true,
  });
  const html = resp.getContentText();
  Logger.log(`HTTP ${resp.getResponseCode()} หน้าเริ่ม ${start} (ยาว ${html.length})`);

  const targets = readTargetRates();
  const d0 = new Date(start + 'T00:00:00+07:00');
  const dates = [];
  for (let i = 0; i < PAGE_SIZE_DAYS; i++) {
    dates.push(Utilities.formatDate(new Date(d0.getTime() + i * 86400000), 'Asia/Bangkok', 'yyyy-MM-dd'));
  }

  Object.keys(ROOM_LH_MAP).forEach(room => {
    const { roomTypeId, ratePlanId } = ROOM_LH_MAP[room];
    const ids = extractRateIdsForRoom(html, roomTypeId, ratePlanId);
    if (!ids) { Logger.log(`${room}: หา anchor/แถวราคาไม่เจอ`); return; }
    const i = html.indexOf(`room_types/${roomTypeId}/rate_plans/${ratePlanId}/edit`);
    const planName = (html.substring(i, i + 300).match(/>([^<]+)<\/a>/) || [])[1];
    const lh = ids.map(id => {
      const m = html.match(new RegExp('rate_plan_dates\\[' + id + '\\]\\[rate\\]"[^>]*value="([^"]*)"'));
      return m ? Math.round(Number(m[1])) : '?';
    });
    const tg = dates.map(d => (targets[d] && targets[d][room]) || '-');
    Logger.log(`${room} → plan "${planName}" (${ids.length} ช่อง)\n  LH   : ${lh.join(', ')}\n  เป้า : ${tg.join(', ')}`);
  });
}

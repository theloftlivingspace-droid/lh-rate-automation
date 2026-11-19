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

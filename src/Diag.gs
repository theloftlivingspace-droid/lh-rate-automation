/**
 * Diag.gs — ชั่วคราว: ทดสอบหน้า inventory ของ LH ด้วย property id เดิม (เลข) เทียบกับ UUID ใหม่
 * รันมือใน editor: diagLhSession() — ไม่ log ค่าคุกกี้ (log แค่สถานะ/ชื่อคุกกี้/path ของฟอร์ม)
 * ลบไฟล์นี้หลังใช้เสร็จ
 */
function diagLhSession() {
  const cookie = PropertiesService.getScriptProperties().getProperty('LH_SESSION_COOKIE');
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const ids = { old: LH_PROPERTY_ID, uuid: '676149e8-bd5e-4480-abbc-5b538cc8b55f' };
  const queries = { dated: '?start_date=' + today + '&viewable_fields=detailed', locale: '?locale=en' };
  Object.keys(ids).forEach(idKey => {
    Object.keys(queries).forEach(qKey => {
      const url = LH_BASE_URL + '/extranet/properties/' + ids[idKey] + '/inventory/edit' + queries[qKey];
      const r = UrlFetchApp.fetch(url, {
        method: 'get', followRedirects: false, muteHttpExceptions: true,
        headers: { Cookie: LH_COOKIE_NAME + '=' + cookie },
      });
      const h = r.getAllHeaders();
      const body = r.getContentText();
      Logger.log(JSON.stringify({
        id: idKey, q: qKey,
        code: r.getResponseCode(),
        location: h['Location'] || h['location'] || null,
        bodyLen: body.length,
        hasMarker: body.indexOf(LH_AUTH_MARKER) !== -1,
        title: (body.match(/<title>([^<]*)/i) || [])[1] || null,
        formAction: (body.match(/action="(\/extranet\/properties\/[^"]*)"/) || [])[1] || null,
        setCookieNames: [].concat(h['Set-Cookie'] || h['set-cookie'] || []).map(c => String(c).split('=')[0]),
      }));
    });
  });
}

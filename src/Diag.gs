/**
 * Diag.gs — ชั่วคราว: วินิจฉัยว่าทำไม LH ปฏิเสธคุกกี้ที่ sync เข้ามา (ลบไฟล์นี้หลังใช้เสร็จ)
 * รันมือใน editor: diagLhSession() — ไม่ log ค่าคุกกี้ (log แค่สถานะ/ชื่อคุกกี้)
 */
function diagLhSession() {
  const cookie = PropertiesService.getScriptProperties().getProperty('LH_SESSION_COOKIE');
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const url = LH_BASE_URL + '/extranet/properties/' + LH_PROPERTY_ID + '/inventory/edit?start_date=' + today + '&viewable_fields=detailed';
  const r = UrlFetchApp.fetch(url, {
    method: 'get', followRedirects: false, muteHttpExceptions: true,
    headers: { Cookie: LH_COOKIE_NAME + '=' + cookie },
  });
  const h = r.getAllHeaders();
  const body = r.getContentText();
  const setCookieNames = [].concat(h['Set-Cookie'] || h['set-cookie'] || []).map(c => String(c).split('=')[0]);
  Logger.log(JSON.stringify({
    code: r.getResponseCode(),
    location: h['Location'] || h['location'] || null,
    bodyLen: body.length,
    hasMarker: body.indexOf(LH_AUTH_MARKER) !== -1,
    title: (body.match(/<title>([^<]*)/i) || [])[1] || null,
    cookieLen: cookie ? cookie.length : 0,
    setCookieNames: setCookieNames,
  }));
}

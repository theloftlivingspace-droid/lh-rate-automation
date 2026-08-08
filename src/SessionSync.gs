/**
 * SessionSync.gs
 * ---------------------------------------------------------
 * Web App endpoint รับ LH_SESSION_COOKIE ใหม่จาก Chrome extension
 * (ให้ Nathan กดปุ่มเดียวหลัง login ผ่าน MFA แล้ว sync cookie เข้ามาอัตโนมัติ
 *  ไม่ต้องเปิด DevTools/copy-paste เอง)
 *
 * ── วิธี deploy (ทำครั้งเดียว) ──
 * 1. ตั้ง Script Property ชื่อ SESSION_SYNC_TOKEN ให้เป็นค่าสุ่มยาวๆ (คิดเองก็ได้ เช่น
 *    ก็อปมาจาก https://www.uuidgenerator.net) — ใช้ป้องกันไม่ให้คนอื่นยิง endpoint นี้เข้ามาแก้ cookie ได้
 * 2. Deploy > New deployment > เลือกประเภท "Web app"
 *      Execute as: Me
 *      Who has access: Anyone
 * 3. Copy URL ที่ได้ (ลงท้ายด้วย /exec) ไปใส่ในตัว Chrome extension (WEB_APP_URL)
 * 4. เอา SESSION_SYNC_TOKEN เดียวกันไปใส่ใน Chrome extension (SYNC_TOKEN) ด้วย
 * ---------------------------------------------------------
 */

function doPost(e) {
  const respond = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);

  try {
    const rawType = e.postData ? e.postData.type : '(no postData)';
    const rawLen = e.postData && e.postData.contents ? e.postData.contents.length : 0;
    const rawPreview = e.postData && e.postData.contents ? e.postData.contents.substring(0, 200) : '';
    Logger.log(`📥 doPost รับ request — type: ${rawType}, length: ${rawLen}, preview: ${rawPreview}`);

    if (!e.postData || !e.postData.contents) {
      Logger.log('❌ ไม่มี postData.contents เลย — น่าจะโดน redirect drop body ระหว่างทาง');
      return respond({ ok: false, error: 'ไม่มี body ส่งมาถึง doPost (postData ว่าง) — เช็ค redirect/CORS ฝั่ง extension' });
    }

    const body = JSON.parse(e.postData.contents);
    const expectedToken = PropertiesService.getScriptProperties().getProperty('SESSION_SYNC_TOKEN');

    if (!expectedToken) {
      return respond({ ok: false, error: 'SESSION_SYNC_TOKEN ยังไม่ได้ตั้งค่าใน Script Properties' });
    }
    if (!body.token || body.token !== expectedToken) {
      return respond({ ok: false, error: 'unauthorized' });
    }
    if (!body.cookie || String(body.cookie).length < 20) {
      return respond({ ok: false, error: 'cookie ไม่ถูกต้องหรือสั้นเกินไป' });
    }

    const props = PropertiesService.getScriptProperties();
    props.setProperty('LH_SESSION_COOKIE', body.cookie);
    props.setProperty('LH_SESSION_SET_AT', new Date().toISOString());

    Logger.log('✅ LH_SESSION_COOKIE อัปเดตผ่าน SessionSync webapp เมื่อ ' + new Date().toISOString());

    // กดปุ่มเดียวทำทุกขั้นตอน: sync cookie เสร็จ → ต่อด้วย computeTargetRates() + pushRatesToLH() อัตโนมัติ
    // ใช้ one-off trigger เหมือน RemoteTrigger.gs กัน doPost timeout (computeThenPush ใช้เวลาหลายสิบวินาที)
    try {
      ScriptApp.newTrigger('computeThenPush')
        .timeBased()
        .after(1000)
        .create();
      Logger.log('✅ SessionSync: คิว computeThenPush (computeTargetRates + pushRatesToLH) ต่อจาก cookie sync สำเร็จ');
    } catch (queueErr) {
      Logger.log('⚠️ SessionSync: sync cookie สำเร็จ แต่คิว computeThenPush ไม่สำเร็จ — ' + queueErr);
    }

    return respond({ ok: true, updatedAt: new Date().toISOString(), queued: 'computeThenPush' });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

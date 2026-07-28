/**
 * RemoteTrigger.gs
 * ---------------------------------------------------------
 * Web App endpoint (doGet) ให้เรียก pushRatesToLH() / computeTargetRates()
 * จากนอกระบบได้ (เช่นผ่าน Vercel proxy /api/gas-proxy?app=rate)
 * แชร์ Web App deployment เดียวกับ SessionSync.gs (คนละ entry point: doGet vs doPost)
 *
 * ── ตั้งค่าก่อนใช้ (ครั้งเดียว) ──
 * 1. ตั้ง Script Property ชื่อ REMOTE_TRIGGER_TOKEN ให้เป็นค่าสุ่มยาวๆ
 * 2. ถ้ายัง deploy Web App ไม่เคยทำ: Deploy > New deployment > Web app
 *      Execute as: Me / Who has access: Anyone
 *    ถ้า deploy ไปแล้ว (จาก SessionSync): Manage deployments > Edit (ปากกา) > Version: New version > Deploy
 *    (ต้องกด "new version" ทุกครั้งที่โค้ดเปลี่ยน — clasp push อย่างเดียวไม่ทำให้ /exec URL อัปเดต)
 * 3. เอา URL /exec (อันเดียวกับที่ใช้กับ Chrome extension) + REMOTE_TRIGGER_TOKEN ไปตั้งใน gas-proxy.js
 *
 * ── การใช้งาน ──
 *   GET {WEB_APP_URL}/exec?action=pushRates&token=...       → รัน pushRatesToLH() เลย (ใช้ Target_Rates ที่มีอยู่)
 *   GET {WEB_APP_URL}/exec?action=computeAndPush&token=...  → รัน computeTargetRates() ก่อน แล้วค่อย pushRatesToLH()
 *
 * หมายเหตุ: งานจริงถูก "คิว" ผ่าน one-off trigger (ScriptApp...after(1000)) แทนที่จะรันตรงใน doGet
 * เพราะ pushRatesToLH() ใช้เวลาหลายสิบวินาที (มี Utilities.sleep ระหว่างหน้า) ซึ่งอาจเกิน timeout ของ
 * ฝั่ง Vercel proxy ได้ — doGet จึงตอบกลับทันทีว่า "คิวแล้ว" ส่วนผลจริงเช็คได้จาก LINE แจ้งเตือน (ถ้า error)
 * หรือดูคอลัมน์ UpdatedAt ใน Target_Rates / Execution log ใน Apps Script editor
 * ---------------------------------------------------------
 */

function doGet(e) {
  const respond = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);

  const params = (e && e.parameter) || {};
  const expectedToken = PropertiesService.getScriptProperties().getProperty('REMOTE_TRIGGER_TOKEN');

  if (!expectedToken) {
    return respond({ ok: false, error: 'REMOTE_TRIGGER_TOKEN ยังไม่ได้ตั้งค่าใน Script Properties' });
  }
  if (!params.token || params.token !== expectedToken) {
    return respond({ ok: false, error: 'unauthorized' });
  }

  const action = params.action;
  const validActions = { pushRates: 'pushRatesToLH', computeAndPush: 'computeThenPush' };
  const handlerFn = validActions[action];
  if (!handlerFn) {
    return respond({ ok: false, error: 'action ไม่ถูกต้อง — ใช้ pushRates หรือ computeAndPush' });
  }

  try {
    // one-off trigger รันภายใน ~1 วินาที — กัน doGet timeout ตอนงานจริงใช้เวลานาน
    ScriptApp.newTrigger(handlerFn)
      .timeBased()
      .after(1000)
      .create();

    Logger.log(`✅ RemoteTrigger: คิว ${handlerFn} ผ่าน doGet สำเร็จ`);
    return respond({
      ok: true,
      queued: action,
      note: 'งานถูกคิวแล้ว จะรันภายใน ~1 นาที เช็คผลได้ทาง LINE (ถ้ามี error) หรือคอลัมน์ UpdatedAt ใน Target_Rates',
    });
  } catch (err) {
    Logger.log('❌ RemoteTrigger error: ' + err);
    return respond({ ok: false, error: String(err) });
  }
}

// ── รัน computeTargetRates แล้วต่อด้วย pushRatesToLH ทันที (ใช้กับ one-off trigger เท่านั้น) ──
function computeThenPush() {
  computeTargetRates();
  pushRatesToLH();
}

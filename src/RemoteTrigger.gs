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
 *   GET {WEB_APP_URL}/exec?action=diffRates&token=...       → เทียบ Target_Rates vs LH จริง (ไม่แก้อะไร) ผลอยู่ที่ sheet tab "Rate_Diff_Check"
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
  const validActions = { pushRates: 'pushRatesToLH', computeAndPush: 'computeThenPush', diffRates: 'diffRatesVsLH' };
  const handlerFn = validActions[action];
  if (!handlerFn) {
    return respond({ ok: false, error: 'action ไม่ถูกต้อง — ใช้ pushRates หรือ computeAndPush' });
  }

  try {
    // one-off trigger รันภายใน ~1 วินาที — กัน doGet timeout ตอนงานจริงใช้เวลานาน
    // อัปเดต 9 ส.ค. 2026: ลบ trigger ค้างของ handler เดิมก่อนสร้างใหม่เสมอ (เหมือน SessionSync.gs)
    // กัน trigger สะสมจนชนลิมิต 20 trigger/สคริปต์
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === handlerFn) ScriptApp.deleteTrigger(t);
    });
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

// ── ตั้ง trigger คืนละ 1 ตัว รัน computeThenPush (แทน 2 trigger แยกของ compute/push) ──
// อัปเดต 9 ส.ค. 2026: เดิมใช้ trigger แยก 2 ตัว (computeTargetRates atHour(2) ไม่ได้ตั้ง
// nearMinute เลยสุ่มเวลาได้ทั้งชั่วโมง / pushRatesToLH atHour(2).nearMinute(20) ซึ่งจริงๆ
// คือ "ใกล้นาที 20 ± ~15 นาที" ไม่ใช่ 02:20 ตายตัว) — ผลคือ push อาจสุ่มเวลาไปตกช่วงที่
// compute ยังรันไม่เสร็จ (compute ใช้เวลาได้ถึง 6 นาที/timeout) ทำให้ push อ่าน Target_Rates
// ระหว่างที่ compute กำลัง clearContents()+เขียนทับอยู่ — เสี่ยง push ข้อมูลว่าง/ไม่ครบ
// รวมเป็น trigger เดียวที่รัน compute แล้วต่อ push แบบ sequential ในฟังก์ชันเดียวกัน
// การันตีลำดับ 100% ไม่มี race จาก trigger timing อีกต่อไป
function setupNightlyComputeAndPushTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'computeTargetRates' || fn === 'pushRatesToLH' || fn === 'computeThenPush') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('computeThenPush')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .nearMinute(0)
    .inTimezone('Asia/Bangkok')
    .create();
  Logger.log('ตั้ง trigger เรียบร้อย: computeThenPush ทุกคืน ~02:00 (ลบ trigger แยกของ compute/push เดิมทิ้งแล้ว)');
}

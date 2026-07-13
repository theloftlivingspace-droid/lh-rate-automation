// ── ตั้งค่า 2 บรรทัดนี้ก่อนใช้งาน ──
// WEB_APP_URL: ได้จากตอน deploy Apps Script เป็น Web App (Deploy > New deployment > Web app)
//              ต้องลงท้ายด้วย /exec
// SYNC_TOKEN:  ต้องตรงกับค่าที่ตั้งไว้ใน Script Properties -> SESSION_SYNC_TOKEN
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbx_z1v7FEqmthTKfZPoLsyqdIc4NJENXpfsZ315dDLzdIHwznSsOQqnG1UxkyqhOCk/exec";
const SYNC_TOKEN = "KTxEAEYfhxYqlbVrKp-t00BkNSdqJ8iv92gO-3l8ut0";

const btn = document.getElementById("syncBtn");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  setStatus("กำลังอ่านคุกกี้จาก apac.littlehotelier.com ...");

  try {
    const cookie = await chrome.cookies.get({
      url: "https://apac.littlehotelier.com",
      name: "_littlehotelier_session",
    });

    if (!cookie) {
      setStatus("❌ ไม่พบคุกกี้ _littlehotelier_session\nกรุณา login ที่ apac.littlehotelier.com ให้เสร็จก่อน (ผ่าน MFA แล้ว)");
      btn.disabled = false;
      return;
    }

    setStatus("กำลังส่งไปอัปเดต Apps Script ...");

    const resp = await fetch(WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" }, // เลี่ยง CORS preflight กับ Apps Script
      body: JSON.stringify({ token: SYNC_TOKEN, cookie: cookie.value }),
    });

    const data = await resp.json();

    if (data.ok) {
      setStatus("✅ Sync สำเร็จ! เวลา: " + new Date(data.updatedAt).toLocaleString("th-TH"));
    } else {
      setStatus("❌ ล้มเหลว: " + (data.error || "ไม่ทราบสาเหตุ"));
    }
  } catch (err) {
    setStatus("❌ เกิดข้อผิดพลาด: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── ตั้งค่า 3 บรรทัดนี้ก่อนใช้งาน ──
// WEB_APP_URL:         ได้จากตอน deploy Apps Script เป็น Web App (Deploy > New deployment > Web app)
//                      ต้องลงท้ายด้วย /exec — ใช้ /exec เดียวกันทั้ง sync cookie (doPost) และ push rate (doGet)
// SYNC_TOKEN:          ต้องตรงกับค่าที่ตั้งไว้ใน Script Properties -> SESSION_SYNC_TOKEN
// REMOTE_TRIGGER_TOKEN: ต้องตรงกับค่าที่ตั้งไว้ใน Script Properties -> REMOTE_TRIGGER_TOKEN (ดูได้จาก
//                      Apps Script editor > Project Settings > Script Properties) — เอาไว้สั่ง push rate
//                      หลัง sync cookie สำเร็จ ต้องใส่ค่าจริงแทน "PASTE_REMOTE_TRIGGER_TOKEN_HERE" ก่อนใช้งาน
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbx_z1v7FEqmthTKfZPoLsyqdIc4NJENXpfsZ315dDLzdIHwznSsOQqnG1UxkyqhOCk/exec";
const SYNC_TOKEN = "KTxEAEYfhxYqlbVrKp-t00BkNSdqJ8iv92gO-3l8ut0";
const REMOTE_TRIGGER_TOKEN = "Lft6801-rXk9pQ2vN7mZs4Tw8Ye3Jc5Hb1Fg0Dq";

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

    if (!data.ok) {
      setStatus("❌ Sync ล้มเหลว: " + (data.error || "ไม่ทราบสาเหตุ"));
      btn.disabled = false;
      return;
    }

    const syncedAt = new Date(data.updatedAt).toLocaleString("th-TH");
    setStatus("✅ Sync cookie สำเร็จ! เวลา: " + syncedAt + "\nกำลังสั่ง push rate เข้า LH...");

    // ── ต่อด้วยสั่ง pushRatesToLH ทันที ผ่าน RemoteTrigger.gs (doGet) ──
    if (REMOTE_TRIGGER_TOKEN === "PASTE_REMOTE_TRIGGER_TOKEN_HERE") {
      setStatus(
        "✅ Sync cookie สำเร็จ! เวลา: " + syncedAt +
        "\n⚠️ ยังไม่ได้ตั้งค่า REMOTE_TRIGGER_TOKEN ใน popup.js จึงไม่ได้สั่ง push rate ให้อัตโนมัติ — sync cookie เฉยๆ ก่อน"
      );
      btn.disabled = false;
      return;
    }

    try {
      const pushUrl = `${WEB_APP_URL}?action=computeAndPush&token=${encodeURIComponent(REMOTE_TRIGGER_TOKEN)}`;
      const pushResp = await fetch(pushUrl, { method: "GET" });
      const pushData = await pushResp.json();

      if (pushData.ok) {
        setStatus(
          "✅ Sync cookie สำเร็จ! เวลา: " + syncedAt +
          "\n✅ สั่ง compute + push rate เข้าคิวแล้ว — รันภายใน ~1 นาที เช็คผลได้ทาง LINE (ถ้ามี error)"
        );
      } else {
        setStatus(
          "✅ Sync cookie สำเร็จ! เวลา: " + syncedAt +
          "\n❌ สั่ง push rate ไม่สำเร็จ: " + (pushData.error || "ไม่ทราบสาเหตุ")
        );
      }
    } catch (pushErr) {
      setStatus(
        "✅ Sync cookie สำเร็จ! เวลา: " + syncedAt +
        "\n❌ เรียก push rate ไม่สำเร็จ: " + pushErr.message
      );
    }
  } catch (err) {
    setStatus("❌ เกิดข้อผิดพลาด: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

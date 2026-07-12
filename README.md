# lh-rate-automation

Nightly rate automation pipeline for Little Hotelier (The Loft Living Space).

## Files
- `computeTargetRates.gs` — คำนวณราคาแนะนำรายวัน (formula-based: base × DOW × Season × Occupancy × LeadTime, ไม่พึ่ง PriceLabs) เขียนลง sheet tab `Target_Rates`
- `LHRateAutomation.gs` — อ่าน `Target_Rates` แล้วโพสต์เข้า Little Hotelier ผ่าน session-cookie-based form automation (LH ไม่มี public API)

## Setup
ดูคอมเมนต์หัวไฟล์ในแต่ละสคริปต์ — ต้องตั้ง Script Property `LH_SESSION_COOKIE` ก่อนใช้งาน และทดสอบด้วย `DRY_RUN = true` ก่อนเปิดใช้จริง

## Trigger schedule
- `computeTargetRates()` — ทุกคืน 02:00 (Asia/Bangkok)
- `pushRatesToLH()` — ทุกคืน ~02:20 (Asia/Bangkok)

## Deploy pipeline
Push เข้า `main` branch (แก้ไฟล์ใน `src/`) → GitHub Action รัน `clasp push --force` เข้า Apps Script project อัตโนมัติ

Script ID: `1WqeF-SF_MgVQ4bBZzkPD6SqvOuyEQiaWEmxhNwFpEgu9NyHmUJY4BazK`

**ต้องตั้ง GitHub Secret ก่อนใช้งาน:** Settings → Secrets and variables → Actions → New repository secret
- ชื่อ: `CLASP_CREDENTIALS`
- ค่า: เนื้อหาไฟล์ `~/.clasprc.json` ทั้งหมด (จาก `clasp login` บนเครื่อง)

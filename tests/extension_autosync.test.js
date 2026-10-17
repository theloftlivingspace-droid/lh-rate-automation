// ทดสอบ logic auto-sync ของ extension/background.js ด้วย chrome API จำลอง
const fs = require("fs"), vm = require("vm"), assert = require("assert");

function makeEnv({ loggedIn, cookieValue, serverOk = true }) {
  const calls = { alarms: [], posts: [], fetches: [] };
  const store = {};
  const listeners = {};
  const ctx = {
    chrome: {
      cookies: { onChanged: { addListener: (f) => (listeners.cookie = f) }, get: async () => ({ value: cookieValue }) },
      alarms: { create: (n, o) => calls.alarms.push([n, o]), onAlarm: { addListener: (f) => (listeners.alarm = f) } },
      storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    },
    importScripts: (f) => vm.runInContext(fs.readFileSync(__dirname + "/../extension/" + f, "utf8").replace(/^const /gm, "var "), ctx),
    fetch: async (url, opts) => {
      calls.fetches.push(url);
      if (url.includes("littlehotelier.com")) return { status: 200, text: async () => (loggedIn ? "xx rate_plan_dates xx" : "login page") };
      calls.posts.push(JSON.parse(opts.body));
      return { json: async () => ({ ok: serverOk }) };
    },
    setTimeout: () => {}, Date, console, URL,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + "/../extension/background.js", "utf8").replace(/^const /gm, "var ").replace(/^let /gm, "var "), ctx);
  return { listeners, calls, store };
}
const LONG = "x".repeat(40);
const set = (name = "_littlehotelier_session") => ({ cookie: { name, domain: "apac.littlehotelier.com" }, removed: false });

(async () => {
  // 1) cookie เปลี่ยน → ตั้ง alarm; cookie อื่น/removed → ไม่ตั้ง
  let e = makeEnv({ loggedIn: true, cookieValue: LONG });
  e.listeners.cookie(set("other")); e.listeners.cookie({ ...set(), removed: true });
  assert.strictEqual(e.calls.alarms.length, 0);
  e.listeners.cookie(set());
  assert.strictEqual(e.calls.alarms.length, 1);

  // 2) ล็อกอินอยู่ → POST ไป Apps Script 1 ครั้ง; ค่าเดิมซ้ำ → ไม่ POST ซ้ำ
  await e.listeners.alarm({ name: "lh-auto-sync" });
  assert.strictEqual(e.calls.posts.length, 1);
  assert.strictEqual(e.calls.posts[0].cookie, LONG);
  await e.listeners.alarm({ name: "lh-auto-sync" });
  assert.strictEqual(e.calls.posts.length, 1, "ห้าม sync ค่าเดิมซ้ำ");

  // 3) ยังไม่ล็อกอิน (คุกกี้ guest) → ห้าม POST
  e = makeEnv({ loggedIn: false, cookieValue: LONG });
  await e.listeners.alarm({ name: "lh-auto-sync" });
  assert.strictEqual(e.calls.posts.length, 0, "ห้ามส่งคุกกี้ guest ไปทับ session ดี");
  assert.strictEqual(e.store.lastAutoSync.reason, "not-logged-in");

  // 4) server ปฏิเสธ → ไม่จำค่าว่า sync แล้ว (ลองใหม่ได้)
  e = makeEnv({ loggedIn: true, cookieValue: LONG, serverOk: false });
  await e.listeners.alarm({ name: "lh-auto-sync" });
  assert.strictEqual(e.store.lastSyncedValue, undefined);
  console.log("extension auto-sync tests OK");
})().catch((x) => { console.error(x); process.exit(1); });

// รัน: node tests/remotetrigger.test.js  (mock ScriptApp — ไม่แตะ Apps Script จริง)
// ยืนยันว่า doGet ไม่ลบ trigger กลางคืนของ computeThenPush / pushRatesToLH / diffRatesVsLH
const fs=require('fs'), assert=require('assert');
let triggers, created, ran;
global.Logger={log:()=>{}};
global.PropertiesService={getScriptProperties:()=>({getProperty:k=>k==='REMOTE_TRIGGER_TOKEN'?'tok':null})};
global.ContentService={MimeType:{JSON:'json'},createTextOutput:s=>({s,setMimeType(){return this}})};
const mk=fn=>({getHandlerFunction:()=>fn,id:fn});
global.ScriptApp={
  getProjectTriggers:()=>triggers.slice(),
  deleteTrigger:t=>{triggers=triggers.filter(x=>x!==t)},
  newTrigger:fn=>({timeBased:()=>({after:()=>({create:()=>{const t=mk(fn);triggers.push(t);created.push(fn)}})})}),
};
global.computeTargetRates=()=>ran.push('compute'); global.pushRatesToLH=()=>ran.push('push'); global.diffRatesVsLH=()=>ran.push('diff');
eval(fs.readFileSync(require('path').join(__dirname,'..','src','RemoteTrigger.gs'),'utf8').replace(/^const /gm,'global.').replace(/^function (\w+)/gm,'global.$1 = function'));
const call=a=>JSON.parse(doGet({parameter:{token:'tok',action:a}}).s);
const handlers=()=>triggers.map(t=>t.getHandlerFunction()).sort();
const reset=()=>{triggers=[mk('computeThenPush'),mk('diffRatesVsLH'),mk('pushRatesToLH'),mk('keepLhSessionAlive')];created=[];ran=[];};

for (const [action,once] of [['computeAndPush','computeThenPushOnce'],['diffRates','diffRatesVsLHOnce'],['pushRates','pushRatesToLHOnce']]) {
  reset(); assert.strictEqual(call(action).ok,true);
  assert.deepStrictEqual(created,[once]);
  for (const keep of ['computeThenPush','diffRatesVsLH','pushRatesToLH','keepLhSessionAlive']) assert.ok(handlers().includes(keep),action+' ลบ trigger '+keep);
  // กดซ้ำ: one-off ไม่สะสม
  call(action); assert.strictEqual(handlers().filter(h=>h===once).length,1);
}
// ตัวห่อเรียกฟังก์ชันจริง
reset(); computeThenPushOnce(); assert.deepStrictEqual(ran,['compute','push']);
reset(); pushRatesToLHOnce(); diffRatesVsLHOnce(); assert.deepStrictEqual(ran,['push','diff']);
// token ผิด/action ผิดต้องไม่สร้าง trigger
reset(); assert.strictEqual(JSON.parse(doGet({parameter:{token:'bad',action:'pushRates'}}).s).ok,false);
assert.strictEqual(call('nope').ok,false); assert.deepStrictEqual(created,[]);
console.log('RemoteTrigger tests OK');

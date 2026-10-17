// รัน: node tests/lhsession.test.js  (mock UrlFetchApp/PropertiesService — ไม่แตะ LH จริง)
const fs=require('fs'), assert=require('assert');
let store={}, logs=[], notified=[], sleeps=0, hour=14, nextResp=[], fetched=[];
global.LH_BASE_URL='https://x'; global.LH_PROPERTY_ID='1';
global.Logger={log:m=>logs.push(m)};
global.PropertiesService={getScriptProperties:()=>({getProperty:k=>store[k]===undefined?null:store[k],setProperty:(k,v)=>{store[k]=String(v)}})};
global.Utilities={sleep:()=>{sleeps++},formatDate:(d,tz,f)=>f==='H'?String(hour):'2026-10-16'};
global.LockService={getScriptLock:()=>({tryLock:()=>global.__lock!==false,releaseLock:()=>{}})};
global.ScriptApp={getProjectTriggers:()=>[],deleteTrigger:()=>{},newTrigger:()=>({timeBased:()=>({everyMinutes:()=>({create:()=>{}})})})};
global.UrlFetchApp={fetch:(url,o)=>{fetched.push(o.headers.Cookie); const r=nextResp.shift(); if(r instanceof Error) throw r; return r;}};
global.notifySessionExpired=a=>notified.push(a); global.getSessionAgeStr_=()=>'age';
eval(fs.readFileSync(require('path').join(__dirname,'..','src','LHSession.gs'),'utf8').replace(/^const /gm,'global.').replace(/^function (\w+)/gm,'global.$1 = function'));
const R=(code,body='',hdr={})=>({getResponseCode:()=>code,getContentText:()=>body,getAllHeaders:()=>hdr});
const NEW='A'.repeat(40), OLD='O'.repeat(40);
const reset=()=>{store={LH_SESSION_COOKIE:OLD,LH_SESSION_SET_AT:'2026-10-16T01:00:00.000Z'};logs=[];notified=[];sleeps=0;nextResp=[];fetched=[];hour=14;global.__lock=true;};

// 1) rotation on authenticated page
reset(); nextResp=[R(200,'x rate_plan_dates',{'Set-Cookie':`_littlehotelier_session=${NEW}; path=/; HttpOnly`})];
lhFetch_('u',{method:'get'}); assert.strictEqual(store.LH_SESSION_COOKIE,NEW); assert.strictEqual(store.LH_SESSION_ROTATIONS,'1'); assert.strictEqual(fetched[0],'_littlehotelier_session='+OLD);
// 2) uses latest cookie next request
nextResp=[R(200,'rate_plan_dates')]; lhFetch_('u',{method:'get'}); assert.strictEqual(fetched[1],'_littlehotelier_session='+NEW);
// 3) NO rotation from login page (would overwrite good cookie with guest cookie)
reset(); nextResp=[R(200,'<html>sign in</html>',{'Set-Cookie':`_littlehotelier_session=${NEW}; path=/`})];
lhFetch_('u',{method:'get'}); assert.strictEqual(store.LH_SESSION_COOKIE,OLD);
// 4) NO rotation from POST or non-200 or deleted/short cookie
reset(); nextResp=[R(200,'rate_plan_dates',{'Set-Cookie':`_littlehotelier_session=${NEW}`})]; lhFetch_('u',{method:'post'}); assert.strictEqual(store.LH_SESSION_COOKIE,OLD);
reset(); nextResp=[R(302,'rate_plan_dates',{'Set-Cookie':`_littlehotelier_session=${NEW}`})]; lhFetch_('u',{method:'get'}); assert.strictEqual(store.LH_SESSION_COOKIE,OLD);
reset(); nextResp=[R(200,'rate_plan_dates',{'Set-Cookie':'_littlehotelier_session=; expires=Thu, 01 Jan 1970'})]; lhFetch_('u',{method:'get'}); assert.strictEqual(store.LH_SESSION_COOKIE,OLD);
// 5) array Set-Cookie
reset(); nextResp=[R(200,'rate_plan_dates',{'Set-Cookie':['other=1; path=/',`_littlehotelier_session=${NEW}; path=/`]})]; lhFetch_('u',{method:'get'}); assert.strictEqual(store.LH_SESSION_COOKIE,NEW);
// 6) classification + retries
reset(); nextResp=[R(200,'rate_plan_dates')]; assert.strictEqual(checkSessionState_(),'valid');
reset(); nextResp=[R(200,'login')]; assert.strictEqual(checkSessionState_(),'expired'); assert.strictEqual(sleeps,0);
reset(); nextResp=[R(302,'')]; assert.strictEqual(checkSessionState_(),'expired');
reset(); nextResp=[R(503),R(502),R(200,'rate_plan_dates')]; assert.strictEqual(checkSessionState_(),'valid'); assert.strictEqual(sleeps,2);
reset(); nextResp=[new Error('dns'),R(429),R(500)]; assert.strictEqual(checkSessionState_(),'transient');
// 7) keep-alive behaviors
reset(); nextResp=[R(200,'rate_plan_dates')]; keepLhSessionAlive(); assert.ok(store.LH_SESSION_LAST_OK_AT); assert.strictEqual(notified.length,0);
reset(); nextResp=[R(503),R(503),R(503)]; keepLhSessionAlive(); assert.strictEqual(notified.length,0); assert.ok(!store.LH_SESSION_EXPIRED_AT);
reset(); nextResp=[R(200,'login')]; keepLhSessionAlive(); assert.strictEqual(notified.length,1); assert.ok(store.LH_SESSION_EXPIRED_AT);
// ไม่แจ้งซ้ำจนกว่าจะ sync ใหม่
nextResp=[R(200,'login')]; keepLhSessionAlive(); assert.strictEqual(notified.length,1); 
store.LH_SESSION_SET_AT='2026-10-17T09:00:00.000Z'; nextResp=[R(200,'login')]; keepLhSessionAlive(); assert.strictEqual(notified.length,2);
// quiet hours: ตรวจเจอแต่ไม่แจ้ง และไม่ตั้ง flag
reset(); hour=23; nextResp=[R(200,'login')]; keepLhSessionAlive(); assert.strictEqual(notified.length,0); assert.ok(!store.LH_SESSION_EXPIRED_AT);
reset(); hour=3; nextResp=[R(200,'login')]; keepLhSessionAlive(); assert.strictEqual(notified.length,0);
// lock busy → ไม่เรียก LH
reset(); global.__lock=false; nextResp=[R(200,'login')]; keepLhSessionAlive(); assert.strictEqual(fetched.length,0);
console.log('LHSession tests OK');

import { chromium, devices } from 'playwright';
// Multi-user browser test against the local Firebase emulators. Never touches production:
// it copies this checkout to a temporary folder and points the copy at 127.0.0.1 before serving it.
// Prerequisites: Node 22+, `npm i playwright` and Google Chrome, Java, and the emulators running:
//   npx firebase-tools emulators:start --only auth,database --project demo-huntlink
// (with a firebase.json that loads database.rules.json; see _qa/README.md). Takes about 5 minutes.
import { createServer } from 'node:http';
import { readFile, cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const work=await mkdtemp(path.join(tmpdir(),'huntlink-e2e-'));
for(const file of ['index.html','offline.html','offline.js','public-land.js','map-nav.css','waypoints.js','offline-states.json','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','vendor']) await cp(path.join(root,file),path.join(work,file),{recursive:true});
let page=await readFile(work+'/index.html','utf8');
const swap=(a,b)=>{if(!page.includes(a))throw Error('patch failed: '+a);page=page.replace(a,b);};
swap("import { getAuth, signInAnonymously, signOut }","import { getAuth, signInAnonymously, signOut, connectAuthEmulator }");
swap("import { getDatabase, ref,","import { getDatabase, connectDatabaseEmulator, ref,");
swap("const auth=getAuth(app), db=getDatabase(app);","const auth=getAuth(app), db=getDatabase(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectDatabaseEmulator(db,'127.0.0.1',9000);");
swap("databaseURL:'https://huntlink-9c932-default-rtdb.firebaseio.com'","databaseURL:'http://127.0.0.1:9000?ns=demo-huntlink'");
swap("projectId:'huntlink-9c932'","projectId:'demo-huntlink'");
await writeFile(work+'/index.html',page);
const types={'.js':'application/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{try{const file=decodeURIComponent(new globalThis.URL(req.url,'http://x').pathname);const data=await readFile(work+(file.endsWith('/')?file+'index.html':file));res.writeHead(200,{'Content-Type':types[path.extname(file)||'.html']||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const APP='http://127.0.0.1:'+server.address().port+'/', PW='synthetic-e2e-pass', shots=work+'/';
const DB='http://127.0.0.1:9000/', NS='?ns=demo-huntlink';
const admin=(method,path,body)=>fetch(DB+path+'.json'+NS,{method,headers:{Authorization:'Bearer owner'},body:body&&JSON.stringify(body)}).then(r=>r.json());
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);
let fails=0; const ok=(c,m)=>{log(c?'PASS':'FAIL',m);if(!c)fails++;};
const browser=await chromium.launch({channel:'chrome'}); const phone=devices['Pixel 7'];
async function user(label, geo, {perms=['geolocation'],init,block}={}){
  const ctx=await browser.newContext({...phone, geolocation:geo, permissions:perms});
  await ctx.route(/basemap\.nationalmap\.gov|services\.arcgis\.com/, r=>r.fulfill({status:204}));
  await ctx.route(/gstatic\.com|unpkg\.com/, r=>{log(label,'UNEXPECTED CDN REQUEST',r.request().url());r.abort();});
  if(block)await ctx.route(block,r=>r.abort());
  if(init)await ctx.addInitScript(init);
  const page=await ctx.newPage(); page.on('pageerror',e=>log(label,'PAGEERROR:',e.message));
  await page.goto(APP); return {ctx,page,label};
}
async function join(u,name){await u.page.waitForFunction(()=>!document.getElementById('enter').disabled,null,{timeout:20000});await u.page.fill('#name',name);await u.page.fill('#password',PW);await u.page.click('#enter');await u.page.waitForSelector('#app:not([hidden])',{timeout:10000});}
const txt=(u,id)=>u.page.locator('#'+id).textContent();
const tone=u=>u.page.locator('#statusBar').getAttribute('class');
const friends=async u=>{await u.page.evaluate(()=>{if(document.getElementById('friends').hidden)document.getElementById('huntersTool').click();});return txt(u,'friends');};
await admin('PUT','',{config:{groupPassword:PW}});

// 3. no CDN: load + join with gstatic/unpkg blocked
const A=await user('alice',{latitude:45.0,longitude:-115.0,accuracy:8});
await join(A,'Alice Smith');
await A.page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
const cached=await A.page.evaluate(async()=>{
  const urls=['vendor/leaflet/leaflet.js','vendor/leaflet/leaflet.css','vendor/firebase/firebase-app.js','vendor/firebase/firebase-auth.js','vendor/firebase/firebase-database.js'];
  return (await Promise.all(urls.map(async url=>(await caches.match(new URL(url,location.href)))?.ok))).every(Boolean);
});
ok(cached,'service worker cached Leaflet and all three Firebase modules');
ok(true,'app loads and joins with gstatic/unpkg blocked (bundled Leaflet + Firebase)');
const B=await user('bob',{latitude:45.003,longitude:-115.002,accuracy:12}); await join(B,'Bob');
await A.page.click('#share'); await A.page.waitForTimeout(3000);
ok((await tone(A))==='tone-live' && (await txt(A,'status')).includes('Sharing live'),'status bar live: '+await txt(A,'status')+' | '+await txt(A,'statusDetail'));
await B.page.waitForFunction(()=>document.getElementById('friends').textContent.includes('Alice'),null,{timeout:15000});
await B.page.click('#locate'); await B.page.waitForTimeout(2000);
const bl=await friends(B); ok(/Alice Smith · GPS fix \d+s ago · ±26 ft · \d+ yd (N|NE|E|SE|S|SW|W|NW)/.test(bl),'list shows color/initials row with distance: '+bl);
ok(await B.page.locator('.hunter-dot').first().textContent()==='AS','marker initials AS');
await B.page.screenshot({path:shots+'01-bob-live.png'});
// 1. stationary heartbeat: no movement for 150 s
const t0=(await admin('GET','locations')); const firstUpdate=Object.values(t0)[0].updatedAt;
await B.page.waitForTimeout(150000);
const t1=Object.values(await admin('GET','locations'))[0];
ok(t1.updatedAt>firstUpdate+60000,'heartbeat refreshed updatedAt while stationary (+'+Math.round((t1.updatedAt-firstUpdate)/1000)+'s)');
const bl2=await friends(B); ok(bl2.includes('Alice Smith · Sharing · fix'),'stationary hunter still visible after 150 s: '+bl2);
log('alice status while stationary:',await txt(A,'status'),'|',await tone(A));
await B.page.screenshot({path:shots+'02-bob-stationary.png'});
// 4. reload while sharing resumes sharing
await A.page.reload(); await A.page.waitForSelector('#app:not([hidden])',{timeout:15000}); await A.page.waitForTimeout(1500);
ok((await txt(A,'share')).includes('Stop sharing'),'sharing resumes after reload: '+await txt(A,'status'));
// 6/7. offline: Alice drops signal -> stays as last-known on Bob's map
await A.ctx.setOffline(true); await A.page.waitForTimeout(6000);
ok((await tone(A))==='tone-offline' && (await txt(A,'connection'))==='Offline','alice offline tone: '+await txt(A,'status'));
await B.page.waitForTimeout(90000);
const bl3=await friends(B); ok(bl3.includes('Alice Smith · Last seen'),'offline hunter kept as last-known: '+bl3);
ok(await B.page.locator('.hunter-dot.last').count()===1,'last-known marker faded');
await B.page.screenshot({path:shots+'03-bob-last-known.png'});
await A.ctx.setOffline(false);
await A.page.waitForFunction(()=>document.getElementById('connection').textContent==='Online',null,{timeout:60000});
await A.page.waitForTimeout(3000);
ok(!(await txt(A,'status')).includes('Offline'),'reconnect status updated: '+await txt(A,'status'));
// cache for offline map
const cache=await B.page.evaluate(()=>JSON.parse(localStorage.getItem('huntlinkLastKnown')));
ok(cache?.hunters?.[0]?.name==='Alice Smith','last-known spots cached on device for the offline map');
// stop sharing removes record
await A.page.click('#share'); await A.page.waitForTimeout(3000);
ok(!(await admin('GET','locations')),'stop sharing removes server record');
// 6h cleanup by a member under real rules
await admin('PUT','locations/ghost',{name:'Ghost',lat:45,lng:-115,accuracy:5,updatedAt:Date.now()-7*3600000});
await B.page.reload(); await B.page.waitForSelector('#app:not([hidden])',{timeout:15000}); await B.page.waitForTimeout(4000);
ok(!(await admin('GET','locations/ghost')),'member client removed a 6-hour-old record (allowed by new rule)');
// 2. GPS timeouts keep sharing
const C=await user('carol',{latitude:45,longitude:-115},{init:()=>{let id=0;navigator.geolocation.watchPosition=(ok,err,o)=>{++id;setTimeout(()=>ok({coords:{latitude:45.001,longitude:-115,accuracy:8},timestamp:Date.now()}),300);setTimeout(()=>err({code:3,message:'Timeout'}),3000);setTimeout(()=>err({code:2,message:'Unavailable'}),5000);return id;};navigator.geolocation.clearWatch=()=>{};navigator.geolocation.getCurrentPosition=()=>{};}});
await join(C,'Carol'); await C.page.click('#share'); await C.page.waitForTimeout(7000);
ok((await txt(C,'share')).includes('Stop sharing') && (await txt(C,'status')).includes('Weak GPS') && (await tone(C))==='tone-weak','GPS timeouts keep sharing with weak-GPS state: '+await txt(C,'status'));
await C.page.screenshot({path:shots+'04-carol-weak.png'});
// 4. startup with database unreachable -> offline map, not password prompt
await C.ctx.close();
const D=await user('dave',{latitude:45,longitude:-115}); await join(D,'Dave');
await D.ctx.routeWebSocket(/9000/,ws=>ws.close()); await D.ctx.route(/127\.0\.0\.1:9000/,r=>r.abort());
await D.page.reload(); await D.page.waitForTimeout(12000);
ok(await D.page.locator('#app').isVisible() && !(await txt(D,'error')).includes('password'),'no signal at startup opens map offline: '+await txt(D,'status'));
await D.ctx.close();
// 4. password rotation -> clear message
await admin('PUT','config/groupPassword','synthetic-pass-3');
await B.page.reload(); await B.page.waitForTimeout(6000);
ok((await txt(B,'error')).includes('password changed'),'rotated password: '+await txt(B,'error'));
await admin('PUT','config/groupPassword',PW);
// 3. vendor files blocked -> watchdog
const E=await user('erin',{latitude:45,longitude:-115},{block:/vendor\/firebase/});
await E.page.waitForTimeout(2500);
ok((await txt(E,'error')).includes("couldn't finish loading") && await E.page.locator('#reload').isVisible(),'load failure explained with Reload: '+await txt(E,'error'));
await E.page.screenshot({path:shots+'05-load-failure.png'});
await A.page.screenshot({path:shots+'06-alice.png'});
await browser.close(); server.close(); log('FAILURES',fails,'· screenshots in',work); process.exit(fails?1:0);

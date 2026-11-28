import { chromium, devices } from 'playwright';
// HuntLinq groups test with several simulated phones against the local Firebase emulators. Never touches production:
// it copies this checkout to a temporary folder and points the copy at 127.0.0.1 before serving it.
// Prerequisites: Node 22+, `npm i playwright` and Google Chrome, Java, and the emulators running:
//   npx firebase-tools emulators:start --only auth,database --project demo-huntlink
// (with a firebase.json that loads database.rules.json; see _qa/README.md). Takes about 2 minutes. Set HUNTLINQ_SHOTS=/some/folder to keep screenshots.
import { createServer } from 'node:http';
import { readFile, cp, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const work=await mkdtemp(path.join(tmpdir(),'huntlink-groups-'));
for(const file of ['index.html','offline.html','privacy.html','offline.js','public-land.js','map-nav.css','waypoints.js','offline-states.json','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','vendor']) await cp(path.join(root,file),path.join(work,file),{recursive:true});
let page=await readFile(work+'/index.html','utf8');
const swap=(a,b)=>{if(!page.includes(a))throw Error('patch failed: '+a);page=page.replace(a,b);};
swap("import { getAuth, signInAnonymously, signOut }","import { getAuth, signInAnonymously, signOut, connectAuthEmulator }");
swap("import { getDatabase, ref,","import { getDatabase, connectDatabaseEmulator, ref,");
swap("const auth=getAuth(app), db=getDatabase(app);","const auth=getAuth(app), db=getDatabase(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectDatabaseEmulator(db,'127.0.0.1',9000);");
swap("databaseURL:'https://huntlink-9c932-default-rtdb.firebaseio.com'","databaseURL:'http://127.0.0.1:9000?ns=demo-huntlink-default-rtdb'");
swap("projectId:'huntlink-9c932'","projectId:'demo-huntlink'");
await writeFile(work+'/index.html',page);
const types={'.js':'application/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{try{const file=decodeURIComponent(new globalThis.URL(req.url,'http://x').pathname);const data=await readFile(work+(file.endsWith('/')?file+'index.html':file));res.writeHead(200,{'Content-Type':types[path.extname(file)||'.html']||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const APP='http://127.0.0.1:'+server.address().port+'/', PW='synthetic-e2e-pass', shots=work+'/';
const DB='http://127.0.0.1:9000/', NS='?ns=demo-huntlink-default-rtdb';
const admin=(method,path,body)=>fetch(DB+path+'.json'+NS,{method,headers:{Authorization:'Bearer owner'},body:body&&JSON.stringify(body)}).then(r=>r.json());
const emulatorRules=await admin('GET','.settings/rules');
const expectedRules=JSON.parse(await readFile(path.join(root,'database.rules.json'),'utf8'));
const {deepStrictEqual}=await import('node:assert/strict');
deepStrictEqual(emulatorRules,expectedRules,'Emulator must enforce the checkout rules before QA');
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);
let fails=0; const ok=(c,m)=>{log(c?'PASS':'FAIL',m);if(!c)fails++;};
const browser=await chromium.launch({channel:'chrome'}); const phone=devices['Pixel 7'];
async function user(label, geo, {perms=['geolocation'],init,block,url}={}){
  const ctx=await browser.newContext({...phone, geolocation:geo, permissions:perms});
  await ctx.route(/basemap\.nationalmap\.gov|services\.arcgis\.com/, r=>r.fulfill({status:204}));
  await ctx.route(u=>/(^|\.)(firebaseio\.com|googleapis\.com|firebaseapp\.com)$/.test(u.hostname), r=>{log(label,'BLOCKED PRODUCTION REQUEST',r.request().url());fails++;r.abort();});
  await ctx.route(/gstatic\.com|unpkg\.com/, r=>{log(label,'UNEXPECTED CDN REQUEST',r.request().url());r.abort();});
  if(block)await ctx.route(block,r=>r.abort());
  if(init)await ctx.addInitScript(init);
  const page=await ctx.newPage(); page.on('pageerror',e=>{log(label,'PAGEERROR:',e.message);fails++;});
  page.on('dialog',d=>d.accept());
  await page.goto(url||APP); await page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000}); return {ctx,page,label};
}
const shotDir=process.env.HUNTLINQ_SHOTS||work;
await mkdir(shotDir,{recursive:true});
const shot=(u,name)=>u.page.screenshot({path:path.join(shotDir,name+'.png')});
const txt=(u,sel)=>u.page.locator(sel).innerText();
const visible=(u,sel)=>u.page.locator(sel).isVisible();
const waitMap=u=>u.page.waitForSelector('#app:not([hidden])',{timeout:15000});
const db=p=>admin('GET',p);
await admin('PUT','',{config:{groupPassword:PW}});
const openGroupPanel=async u=>{if(await u.page.locator('#groupPanel').isHidden())await u.page.click('#groupTool');await u.page.waitForSelector('#groupPanel:not([hidden])');};
const openHunters=async u=>{if(await u.page.locator('#friends').isHidden())await u.page.click('#huntersTool');};
const closeTools=async u=>{for(const t of ['#groupTool','#huntersTool'])if((await u.page.locator(t).getAttribute('aria-expanded'))==='true')await u.page.click(t);};

// 1. Leader starts a group.
const A=await user('tj',{latitude:45.0,longitude:-115.0,accuracy:8});
ok(await visible(A,'#start') && !(await visible(A,'#login')),'first visit opens on Start, not the password login');
ok((await txt(A,'#start')).includes('No account needed'),'Start says no account is needed');
await shot(A,'01-start');
await A.page.click('#startGroup');
ok(await visible(A,'#create') && (await txt(A,'#create')).includes('Use any name you want'),'Start a group asks for a group name and your name');
await A.page.fill('#groupNameInput','Elk camp 2026'); await A.page.fill('#createName','TJ');
await shot(A,'02-create');
await A.page.click('#createGo'); await waitMap(A);
await A.page.waitForFunction(()=>document.querySelector('#qr svg path')&&document.getElementById('inviteCode').textContent.length===7,null,{timeout:10000});
ok(await visible(A,'#groupPanel') && await visible(A,'#qr svg'),'after creating, the invite with a QR code opens');
ok((await txt(A,'#groupLabel'))==='Elk camp 2026' && (await txt(A,'#app h1')).includes('HuntLinq'),'map header shows HuntLinq and the group name');
const link=await A.page.locator('#inviteLink').inputValue(); const code=(await txt(A,'#inviteCode')).replace('-','');
ok(/#join=[A-Za-z0-9_-]{22,43}$/.test(link) && link.startsWith(APP),'invite link is this site with the key after # (never sent to the web server)');
ok(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code),'6-character code avoids look-alike letters: '+code);
ok((await txt(A,'#inviteHint')).includes('The code works until'),'invite says how long the code works');
ok((await txt(A,'#memberList')).includes('TJ (you)') && (await txt(A,'#memberList')).includes('Leader'),'roster shows the leader');
ok(await visible(A,'#newCode'),'leader sees New code');
await shot(A,'03-invite');
const g=(await A.page.evaluate(()=>JSON.parse(localStorage.getItem('huntlinkGroup')))).g;
const key=link.split('#join=')[1];
const stored=await db('groups/'+g);
ok(stored.info.name==='Elk camp 2026' && stored.members[Object.keys(stored.members)[0]].role==='leader' && stored.info.invite===key,'group, leader and invite saved together');
ok(!(await A.page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('synthetic-e2e-pass')))),'no password kept on the phone');

// 2. Hunter joins from the invite link.
const B=await user('dave',{latitude:45.003,longitude:-115.0,accuracy:6},{url:link});
await B.page.waitForFunction(()=>document.getElementById('joinTitle').textContent.includes('invited'),null,{timeout:15000});
ok((await txt(B,'#joinTitle'))==="You're invited to Elk camp 2026",'link opens the invite preview');
ok((await txt(B,'#joinWho')).includes('Started by TJ · 1 member: TJ'),'preview shows who started it and who is in it');
await B.page.fill('#joinName','Dave');
await shot(B,'04-join-link');
await B.page.click('#joinGo'); await waitMap(B);
ok(!(await B.page.evaluate(()=>location.hash)),'invite key is cleared from the address bar after joining');
await openGroupPanel(B);
await B.page.waitForFunction(()=>document.getElementById('memberList').textContent.includes('TJ'),null,{timeout:10000});
ok((await txt(B,'#memberList')).includes('Dave (you)') && (await txt(B,'#memberList')).includes('TJ'),'new member sees the roster');
ok(!(await visible(B,'#newCode')),'members do not get New code');
await A.page.waitForFunction(()=>document.getElementById('memberList').textContent.includes('Dave'),null,{timeout:10000});
ok(true,'leader sees Dave join right away');
await closeTools(B);
await B.page.click('#share');
await A.page.waitForFunction(()=>{const f=document.getElementById('friends');return f.textContent.includes('Dave');},null,{timeout:20000}).catch(()=>{});
await openHunters(A);
ok((await txt(A,'#friends')).includes('Dave'),'leader sees Dave on the map after Dave starts sharing');
ok((await txt(A,'#whoSeesText')).includes('other member of Elk camp 2026: Dave'),'Who can see you names the group members: '+(await txt(A,'#whoSeesText')));
await shot(A,'05-map-hunters');

// 3. Another hunter joins with the code.
const C=await user('sam',{latitude:45.006,longitude:-115.0,accuracy:6});
await C.page.click('#joinWithCode'); await C.page.fill('#codeInput',code.slice(0,3).toLowerCase()+'-'+code.slice(3).toLowerCase());
await shot(C,'06-join-code');
await C.page.click('#codeGo');
await C.page.waitForFunction(()=>document.getElementById('joinTitle').textContent.includes('invited'),null,{timeout:15000});
ok((await txt(C,'#joinWho')).includes('2 members: TJ, Dave'),'code leads to the same preview, with members so far: '+(await txt(C,'#joinWho')));
await C.page.fill('#joinName','Sam'); await C.page.click('#joinGo'); await waitMap(C);
ok((await txt(C,'#groupLabel'))==='Elk camp 2026','code join opens the group map');

// 4. A second group stays separate.
const D=await user('other',{latitude:45.0005,longitude:-115.0005,accuracy:6});
await D.page.click('#startGroup'); await D.page.fill('#groupNameInput','Duck blind'); await D.page.fill('#createName','Olivia'); await D.page.click('#createGo'); await waitMap(D);
await closeTools(D); await D.page.click('#share');
await D.page.waitForTimeout(4000);
await openHunters(A);
ok(!(await txt(A,'#friends')).includes('Olivia'),'group 1 never sees a hunter sharing in group 2');
await openHunters(D);
ok(!(await txt(D,'#friends')).includes('Dave'),'group 2 never sees group 1 hunters');
const dGroup=(await D.page.evaluate(()=>JSON.parse(localStorage.getItem('huntlinkGroup')))).g;
const peek=await B.page.evaluate(async gid=>{const {getDatabase,ref,get}=await import('./vendor/firebase/firebase-database.js');try{await get(ref(getDatabase(),'groups/'+gid+'/locations'));return 'read';}catch(e){return String(e.message||e);}},dGroup);
ok(/permission/i.test(peek),'a group 1 phone asking the database for group 2 locations is refused: '+peek);

// 5. Remembered phone: reopening goes straight to the map, and sharing resumes.
await B.page.reload(); await B.page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000}); await waitMap(B);
ok(!(await visible(B,'#login')) && !(await visible(B,'#start')),'returning phone opens the group map with no password');
await B.page.waitForFunction(()=>document.getElementById('status').textContent.includes('Sharing'),null,{timeout:15000}).catch(()=>{});
ok((await txt(B,'#status')).includes('Sharing') && (await txt(B,'#share')).includes('Stop sharing'),'sharing that was on resumes after reopening: '+(await txt(B,'#status')));
await shot(B,'07-returning-map');

// 6. New code: the old code stops working, the new one works.
await openGroupPanel(A); await A.page.click('#newCode');
await A.page.waitForFunction(old=>{const c=document.getElementById('inviteCode').textContent.replace('-','');return c.length===6&&c!==old;},code,{timeout:10000});
const code2=(await txt(A,'#inviteCode')).replace('-','');
await A.page.waitForFunction(()=>document.getElementById('inviteStatus').textContent.includes('old code'),null,{timeout:10000}).catch(()=>{});
ok((await txt(A,'#inviteStatus')).includes('old code no longer works'),'leader makes a new code: '+(await txt(A,'#inviteStatus')));
const E=await user('late',{latitude:45.01,longitude:-115.0,accuracy:6});
await E.page.click('#joinWithCode'); await E.page.fill('#codeInput',code); await E.page.click('#codeGo');
await E.page.waitForFunction(()=>document.getElementById('codeError').textContent.includes("didn't work"),null,{timeout:15000}).catch(()=>{});
ok((await txt(E,'#codeError')).includes("didn't work"),'old code is refused with a clear message');
await E.page.fill('#codeInput',code2); await E.page.click('#codeGo');
await E.page.waitForFunction(()=>document.getElementById('joinTitle').textContent.includes('invited'),null,{timeout:15000});
ok(true,'new code opens the invite');
await E.page.click('#join .back');
ok(await visible(E,'#start'),'Not now goes back to Start without joining');

// 7. A bad link explains itself.
const F=await user('stale',{latitude:45,longitude:-115,accuracy:6},{url:APP+'#join='+'x'.repeat(24)});
await F.page.waitForFunction(()=>document.getElementById('joinTitle').textContent.includes('no longer works'),null,{timeout:15000}).catch(()=>{});
ok((await txt(F,'#joinTitle')).includes('no longer works') && (await txt(F,'#joinError')).includes('new link'),'unknown invite link says to ask for a new one');

// 8. Leaving a group removes your name and spot.
await C.page.click('#logout');
await C.page.waitForSelector('#start:not([hidden])',{timeout:10000});
ok((await txt(C,'#startNote')).includes('You left Elk camp 2026'),'leaving says so on Start');
await A.page.waitForFunction(()=>!document.getElementById('memberList').textContent.includes('Sam'),null,{timeout:10000}).catch(()=>{});
ok(!(await txt(A,'#memberList')).includes('Sam'),'leader roster drops Sam after Sam leaves');
const members=await db('groups/'+g+'/members');
ok(Object.values(members).every(m=>m.name!=='Sam'),'Sam is removed from the database');
const inv=await db('invites/'+key);
ok(!Object.values(inv.people||{}).includes('Sam'),'Sam is removed from the invite preview');
await C.page.reload(); await C.page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000});
ok(await visible(C,'#start'),'after leaving, reopening shows Start, not the old group');

// 9. The original password group still works next to groups.
const L=await user('legacy',{latitude:45.02,longitude:-115.0,accuracy:6});
await L.page.click('#useLegacy'); await L.page.waitForFunction(()=>!document.getElementById('enter').disabled,null,{timeout:20000});
await L.page.fill('#name','Old Timer'); await L.page.fill('#password',PW); await L.page.click('#enter'); await waitMap(L);
ok(await L.page.locator('#groupTool').isHidden(),'original password group opens its map as before');
await L.page.click('#share'); await L.page.waitForTimeout(4000);
const legacyLoc=await db('locations');
ok(Object.values(legacyLoc||{}).some(x=>x.name==='Old Timer'),'original group shares to its own place in the database');
await openHunters(A);
ok(!(await txt(A,'#friends')).includes('Old Timer'),'a new group never sees the original group');


// 10. Leader controls: approval, let in, decline.
await openGroupPanel(A);
ok(await visible(A,'#leaderTools') && !(await visible(B,'#leaderTools')),'leader settings show only for leaders');
await A.page.check('#approvalToggle');
await A.page.waitForFunction(()=>document.getElementById('leaderStatus').textContent.includes('wait for a leader'),null,{timeout:10000});
await shot(A,'08-leader-settings');
const link2=await A.page.locator('#inviteLink').inputValue();
const G=await user('gail',{latitude:45.004,longitude:-115.001,accuracy:6},{url:link2});
await G.page.waitForFunction(()=>document.getElementById('joinGo').textContent==='Ask to join',null,{timeout:15000});
ok((await txt(G,'#joinWho')).includes('approves new members'),'preview says the leader approves new members');
await G.page.fill('#joinName','Gail'); await G.page.click('#joinGo');
await G.page.waitForSelector('#waiting:not([hidden])',{timeout:10000});
ok((await txt(G,'#waitingWho')).includes('TJ will let you in'),'requester sees Request sent');
await shot(G,'09-request-sent');
await G.page.reload(); await G.page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000});
ok(await visible(G,'#waiting'),'request survives closing and reopening the app');
await A.page.waitForFunction(()=>document.getElementById('pendingList').textContent.includes('Gail'),null,{timeout:10000});
ok(await visible(A,'#pendingBox'),'leader sees Gail waiting');
await A.page.locator('#pendingBox').scrollIntoViewIfNeeded(); await shot(A,'10-waiting-to-join');
await A.page.click('#pendingList button.primary');
await waitMap(G);
ok((await txt(G,'#groupLabel'))==='Elk camp 2026','Let in opens the map on the requester phone');
const H=await user('hank',{latitude:45.004,longitude:-115.002,accuracy:6},{url:link2});
await H.page.waitForFunction(()=>document.getElementById('joinGo').textContent==='Ask to join',null,{timeout:15000});
await H.page.fill('#joinName','Hank'); await H.page.click('#joinGo'); await H.page.waitForSelector('#waiting:not([hidden])',{timeout:10000});
await A.page.waitForFunction(()=>document.getElementById('pendingList').textContent.includes('Hank'),null,{timeout:10000});
await A.page.click('#pendingList li:has-text("Hank") button:has-text("Decline")');
await H.page.waitForSelector('#start:not([hidden])',{timeout:10000});
ok((await txt(H,'#startNote')).includes("wasn't accepted"),'declined requester is told plainly');
await A.page.uncheck('#approvalToggle');

// 11. Co-leader and remove.
await A.page.waitForFunction(()=>document.getElementById('memberList').textContent.includes('Gail'),null,{timeout:10000});
await A.page.click('#memberList li:has-text("Gail") button:has-text("Make leader")');
await G.page.waitForFunction(()=>!document.getElementById('leaderTools').hidden||true,null,{timeout:2000});
await openGroupPanel(G);
await G.page.waitForSelector('#leaderTools:not([hidden])',{timeout:10000});
ok(true,'a co-leader gets the leader settings');
await A.page.click('#memberList li:has-text("Dave") button:has-text("Remove")');
await B.page.waitForSelector('#start:not([hidden])',{timeout:15000});
ok((await txt(B,'#startNote')).includes("You're no longer in Elk camp 2026"),'removed hunter is told plainly and the map closes');
await shot(B,'11-removed');
const davesSpot=await db('groups/'+g+'/locations');
ok(!Object.values(davesSpot||{}).some(x=>x.name==='Dave'),"removed hunter's spot is deleted");
await B.page.goto(link2); await B.page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000});
await B.page.waitForFunction(()=>document.getElementById('joinTitle').textContent.includes('invited'),null,{timeout:15000});
await B.page.click('#joinGo');
await B.page.waitForFunction(()=>document.getElementById('joinError').textContent.length>10&&!document.getElementById('joinError').textContent.includes('Joining'),null,{timeout:15000});
ok(await visible(B,'#join') && !(await visible(B,'#app')),'removed phone cannot rejoin with the link: '+(await txt(B,'#joinError')));

// 12. Reset the invite link.
await A.page.click('#resetInvite');
await A.page.waitForFunction(old=>document.getElementById('inviteLink').value!==old,link2,{timeout:10000});
const link3=await A.page.locator('#inviteLink').inputValue();
const I=await user('ivy',{latitude:45,longitude:-115,accuracy:6},{url:link2});
await I.page.waitForFunction(()=>document.getElementById('joinTitle').textContent.includes('no longer works'),null,{timeout:15000}).catch(()=>{});
ok((await txt(I,'#joinTitle')).includes('no longer works'),'old link stops working after a reset');
await I.page.goto(link3); await I.page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000});
await I.page.waitForFunction(()=>document.getElementById('joinTitle').textContent.includes('invited'),null,{timeout:15000});
ok((await txt(I,'#joinWho')).includes('TJ') && (await txt(I,'#joinWho')).includes('Gail'),'new link works and still lists the members');
await I.page.fill('#joinName','Ivy'); await I.page.click('#joinGo'); await waitMap(I);
ok((await txt(G,'#groupLabel'))==='Elk camp 2026','people already in the group stay after a reset');

// 13. Optional group password each time HuntLinq opens.
await A.page.check('#lockToggle'); await A.page.fill('#lockPass','synthetic-lock-1'); await A.page.click('#lockSave');
await A.page.waitForFunction(()=>document.getElementById('leaderStatus').textContent.startsWith('Saved'),null,{timeout:10000});
ok(await visible(A,'#app'),'leader keeps the map after turning on the group password');
await I.page.reload(); await I.page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000});
await I.page.waitForSelector('#unlock:not([hidden])',{timeout:15000});
ok((await txt(I,'#unlockTitle'))==='Elk camp 2026' && (await I.page.locator('#unlockName').inputValue())==='Ivy','returning member is asked for the group password, name filled in');
await shot(I,'12-group-password');
await I.page.fill('#unlockPass','wrong-one'); await I.page.click('#unlockGo');
await I.page.waitForFunction(()=>document.getElementById('unlockError').textContent.includes('Incorrect'),null,{timeout:10000}).catch(()=>{});
ok((await txt(I,'#unlockError')).includes('Incorrect'),'wrong group password is refused');
await I.page.fill('#unlockPass','synthetic-lock-1'); await I.page.click('#unlockGo'); await waitMap(I);
ok(true,'right group password opens the map');
ok(!(await I.page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('synthetic-lock-1')))),'group password is never kept on the phone');
await A.page.uncheck('#lockToggle');
await A.page.waitForFunction(()=>document.getElementById('leaderStatus').textContent.includes('no longer need'),null,{timeout:10000});
await I.page.reload(); await I.page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000}); await waitMap(I);
ok(!(await visible(I,'#unlock')),'with the group password off, the map opens straight away again');

// 14. Several groups on one phone: switch without a new invite.
await closeTools(I); await I.page.click('#share');
await I.page.waitForFunction(()=>document.getElementById('share').textContent.includes('Stop sharing'),null,{timeout:15000});
await I.page.waitForTimeout(3000);
ok(Object.values(await db('groups/'+g+'/locations')||{}).some(x=>x.name==='Ivy'),'Ivy is sharing in Elk camp before switching');
await openGroupPanel(I);

await I.page.click('#switchGroup');
await I.page.waitForSelector('#start:not([hidden])',{timeout:10000});
ok((await txt(I,'#startNote')).includes("still in Elk camp 2026"),'switching says you stay in the group');
await I.page.waitForTimeout(2000);
ok(!Object.values(await db('groups/'+g+'/locations')||{}).some(x=>x.name==='Ivy'),'switching stops sharing in the old group');
ok((await txt(I,'#myGroupList')).includes('Open Elk camp 2026'),'Start screen lists your groups');
await I.page.click('#startGroup'); await I.page.fill('#groupNameInput','Ivy scouting'); await I.page.fill('#createName','Ivy'); await I.page.click('#createGo'); await waitMap(I);
ok((await txt(I,'#groupLabel'))==='Ivy scouting','a member of one group can start a second group');
await openGroupPanel(I); await I.page.click('#switchGroup');
await I.page.waitForSelector('#start:not([hidden])',{timeout:10000});
await shot(I,'13-your-groups');
ok((await txt(I,'#myGroupList')).includes('Open Ivy scouting') && (await txt(I,'#myGroupList')).includes('Open Elk camp 2026'),'both groups are listed');
await I.page.click('#myGroupList button:has-text("Elk camp 2026")'); await waitMap(I);
ok((await txt(I,'#groupLabel'))==='Elk camp 2026','switching back opens the map with no new invite');
await openGroupPanel(I);
await I.page.waitForFunction(()=>document.getElementById('memberList').textContent.includes('Gail'),null,{timeout:10000}).catch(()=>{});
ok((await txt(I,'#memberList')).includes('Gail') && !(await txt(I,'#memberList')).includes('Ivy scouting'),'Elk camp members show again after switching back');
await I.page.reload(); await I.page.waitForFunction(()=>window.huntlinkReady,null,{timeout:20000}); await waitMap(I);
ok((await txt(I,'#groupLabel'))==='Elk camp 2026','a relaunch opens the group you used last');
log('FAILURES',fails,'· screenshots in',shotDir);
await browser.close(); server.close(); process.exit(fails?1:0);

import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {strict as assert} from 'node:assert';
const root=process.cwd(), image=await readFile('./tile');
const fixture={};
for(const state of ['ID','WA']) fixture[state]=JSON.parse(await readFile('./parcels-'+state+'.json','utf8'));
let outage=false,fail=false,served=0,missing=false,flaky=false,retried=0,failAfter=Infinity,requests=0;const flakySeen=new Set();

const server=createServer(async(req,res)=>{
 if(outage){req.socket.destroy();return;}
 if(req.url.startsWith('/parcels?')){
  const q=new URL(req.url,'http://localhost').searchParams;
  const rows=fixture[Number(q.get('geometry').split(',')[0])<-120?'WA':'ID'];
  const ids=(q.get('objectIds')||'').split(',').map(Number);
  const data=q.has('returnIdsOnly')?{objectIdFieldName:'OBJECTID',objectIds:rows.map(f=>f.properties.OBJECTID)}:
    {type:'FeatureCollection',features:missing?[]:rows.filter(f=>ids.includes(f.properties.OBJECTID))};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
 }
 if(req.url.startsWith('/tiles/')){requests++;if(flaky&&requests%10===0&&!flakySeen.has(req.url)){flakySeen.add(req.url);retried++;res.writeHead(503);res.end();return;}if(served>=failAfter){res.writeHead(503);res.end();return;}served++;res.writeHead(fail?503:200,{'Content-Type':'image/png'});res.end(image);return;}
 try{
 const file=new URL(req.url,'http://localhost').pathname.split('/').slice(2).join('/');
 const type=file.endsWith('.js')?'application/javascript':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/json';
 let data=await readFile(root+'/'+file);
 if(file==='public-land.js')data=data.toString().replace(/https:\/\/services.arcgis.com[^']+query/, '/parcels');
 if(file==='offline.js')data=data.toString().replace('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile','/tiles').replace("const map = L.map","const map = window.testMap = L.map");
 res.writeHead(200,{'Content-Type':type});res.end(data);
 }catch{res.writeHead(404);res.end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port+'/HuntLink/';
const chrome=spawn('google-chrome',['--headless','--disable-background-networking','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+root+'/chrome-offline','about:blank']);
let log='';
const wsurl=await new Promise(resolve=>chrome.stderr.on('data',d=>{log+=d;const m=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1]);}));
const socket=new WebSocket(wsurl);await once(socket,'open');
let id=0, waits=new Map(), sid,tab;
socket.onmessage=e=>{const v=JSON.parse(e.data);if(waits.has(v.id)){const [yes,no]=waits.get(v.id);waits.delete(v.id);v.error?no(Error(v.error.message)):yes(v.result);}};
function call(method,params={},sessionId=sid){return new Promise((yes,no)=>{waits.set(++id,[yes,no]);socket.send(JSON.stringify({id,method,params,sessionId:sessionId||undefined}));});}
async function page(url){
 tab=(await call('Target.createTarget',{url:'about:blank'},null)).targetId;
 sid=(await call('Target.attachToTarget',{targetId:tab,flatten:true},null)).sessionId;
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await call('Page.navigate',{url});
}
async function js(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||expression);return r.result.value;}
async function until(expr){for(let i=0;i<170;i++){try{if(await js(expr))return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error(expr+' => '+await js("document.body?.innerText"));}
async function close(){await call('Target.closeTarget',{targetId:tab},null);sid=undefined;}
try {
 await page(base+'offline.html');await until("document.querySelector('#status')?.textContent.includes('Pan')");
 assert(await js("document.title==='Offline topo · HuntLinq' && !document.body.innerText.includes('HuntLink')"));
 const manifest=await js("fetch('manifest.webmanifest').then(r=>r.json())");
 assert(manifest.name==='HuntLinq' && manifest.short_name==='HuntLinq');
 console.log('PASS offline page and manifest use HuntLinq');
 await js("testMap.setView([40,-115],14,{animate:false}); true");assert(await js("document.getElementById('download').disabled"));
 for(const [lat,lng,state] of [[47.3,-115.2,'Montana'],[45.3,-117.3,'Oregon']]){
  await js(`testMap.setView([${lat},${lng}],14,{animate:false}); true`);
  await until(`!download.disabled&&document.getElementById('status').textContent.startsWith('${state} · Outlined')`);
 }
 console.log('PASS Montana and Oregon areas can be selected for offline topo');
 assert(await js("!locate.hidden&&stopGps.hidden"));
 await call('Browser.grantPermissions',{origin:new URL(base).origin,permissions:['geolocation']},null);
 await call('Emulation.setGeolocationOverride',{latitude:43.615,longitude:-116.202,accuracy:8});
 await js("locate.click()");await until("gps.textContent.includes('Private')&&!download.disabled");
 assert(await js("testMap.latLngToContainerPoint([43.615,-116.202]).distanceTo(testMap.getSize().divideBy(2))<=1 && !stopGps.hidden"));
 await js("testMap.panTo([43.64,-116.25],{animate:false});locate.click();true");
 assert(await js("testMap.latLngToContainerPoint([43.615,-116.202]).distanceTo(testMap.getSize().divideBy(2))<=1 && !download.disabled"));
 console.log('PASS initial picker GPS, center, recenter, and eligible download');
 await until("!document.getElementById('download').disabled");
 await js("document.getElementById('download').click()");await until("document.getElementById('status').textContent.includes('Idaho · Saved topo')");
 assert(await js("gps.textContent.includes('Private') && !stopGps.hidden"));
 assert(await js("!landOption.hidden && landToggle.checked && document.querySelectorAll('.leaflet-publicLand-pane path').length===75"));
 missing=true;
 await js("choose.click();testMap.setView([47.04,-122.90],14,{animate:false});download.click();true");await until("statusText().includes('incomplete')".replace('statusText()', "document.getElementById('status').textContent"));
 await js("saved.click()");await until("document.getElementById('status').textContent.includes('Idaho · Saved topo')");
 assert(await js("document.querySelectorAll('.leaflet-publicLand-pane path').length===75"));missing=false;
 console.log('PASS all Idaho parcels retained after incomplete Washington response');
 assert( served>50 );console.log('Idaho pack saved');
 await js("window.prompt=()=> 'Gate';waypointTool.click();pickPoint.click();testMap.fire('click',{latlng:testMap.getCenter()});true");
 await until("pointList.selectedOptions[0]?.text==='Gate'");
 await js("document.getElementById('choose').click();testMap.setView([47.04,-122.90],14,{animate:false});document.getElementById('download').click();document.getElementById('cancel').click();true");
 await until("document.getElementById('status').textContent.includes('incomplete')");
 console.log('Cancel left previous pack available');
 fail=true;await js("document.getElementById('download').click()");await until("document.getElementById('status').textContent.includes('incomplete')");
 await js("document.getElementById('saved').click()");await until("document.getElementById('status').textContent.includes('Idaho · Saved topo')");
 console.log('Failed replacement retained Idaho');
 fail=false;await js("document.getElementById('choose').click();testMap.setView([47.04,-122.90],14,{animate:false});document.getElementById('download').click();true");
 await until("document.getElementById('status').textContent.includes('Washington · Saved topo')");
 await until("Array.from(pointList.options).some(o=>o.text==='Gate')");
 await js("pointList.value=pointList.options[1].value;pointList.dispatchEvent(new Event('change'));true");
 assert(await js("returnInfo.textContent.includes('Outside this saved map')&&showPoint.disabled"));
 await js("choose.click();landToggle.click();download.click();true");
 await until("landNote.textContent.includes('Topo only')&&!landNote.hidden");
 assert(await js("landOption.hidden && !document.querySelector('.leaflet-publicLand-pane path')"));
 const wa=fixture.WA;fixture.WA=[];
 await js("choose.click();download.click();true");await until("landNote.textContent.includes('no mapped public parcels')&&!landNote.hidden");
 fixture.WA=wa;
 await js("choose.click();download.click();true");await until("document.querySelectorAll('.leaflet-publicLand-pane path').length===29");
 console.log('PASS topo-only compatibility and empty inventory');
 await close();outage=true;
 await page(base);await until("document.getElementById('status')?.textContent.includes('Washington · Saved topo')");
 await until("Array.from(document.querySelectorAll('img.leaflet-tile')).some(i=>i.naturalWidth===256&&i.src.startsWith('blob:'))");
 await until("document.querySelectorAll('.leaflet-publicLand-pane path').length===29");
 await js("document.querySelector('.leaflet-publicLand-pane path').dispatchEvent(new MouseEvent('click',{bubbles:true}));true");
 await until("document.querySelector('.leaflet-popup-content')?.textContent.includes('Manager:')");
 await js("testMap.closePopup();landToggle.click();true");assert(await js("!document.querySelector('.leaflet-publicLand-pane path')"));
 await js("landToggle.click();true");assert(await js("document.querySelectorAll('.leaflet-publicLand-pane path').length===29"));
 assert(await js("document.querySelector('nav').getBoundingClientRect().right <= testMap.getContainer().getBoundingClientRect().left+1 && waypointTool.offsetHeight>=44"));
 await js("waypointTool.click()");
 await until("waypoints.open && waypointTool.getAttribute('aria-expanded')==='true'");
 await js("waypointTool.click()");
 await until("!waypoints.open && waypointTool.getAttribute('aria-expanded')==='false'");
 console.log('PASS offline Washington geometry, parcel popup, and layer visibility');
 await call('Browser.grantPermissions',{origin:new URL(base).origin,permissions:['geolocation']},null);
 await call('Emulation.setGeolocationOverride',{latitude:47.04,longitude:-122.90,accuracy:8});
 await js("document.getElementById('locate').click()");await until("document.getElementById('gps').textContent.includes('Private')");
 await js("waypointTool.click();window.prompt=()=> 'Truck';markGps.click();true");
 await until("pointList.selectedOptions[0]?.text==='Truck'");
 assert(await js("returnInfo.textContent.includes('Within GPS accuracy')"));
 await js("window.realNow=Date.now;Date.now=()=>realNow()+60000;markGps.click();Date.now=realNow;true");
 assert(await js("waypointHint.textContent.includes('fresh GPS fix')"));
 await js("window.prompt=()=> '   ';pickPoint.click();testMap.fire('click',{latlng:testMap.getCenter()});true");
 assert(await js("waypointHint.textContent.includes('between 1 and 50')"));
 await js("window.prompt=()=> 'Camp';pickPoint.click();testMap.fire('click',{latlng:L.latLng(47.041,-122.90)});true");
 await until("pointList.selectedOptions[0]?.text==='Camp'");
 assert(await js("returnInfo.textContent.includes('yd N')"));
 await js("window.prompt=()=> 'Base camp';renamePoint.click();true");
 await until("pointList.selectedOptions[0]?.text==='Base camp'");
 await close();await page(base);await until("Array.from(document.querySelector('#pointList')?.options||[]).some(o=>o.text==='Truck')");
 await js("waypointTool.click();pointList.value=Array.from(pointList.options).find(o=>o.text==='Truck').value;pointList.dispatchEvent(new Event('change'));true");
 await until("Math.abs(testMap.getCenter().lat-47.04)<0.00003");
 await call('Emulation.setGeolocationOverride',{latitude:47.039,longitude:-122.90,accuracy:6});
 await js("locate.click()");await until("returnInfo.textContent.includes('yd N')");
 await js("window.confirm=()=>false;deletePoint.click();true");
 assert(await js("pointList.selectedOptions[0]?.text==='Truck'"));
 await js("window.confirm=()=>true;deletePoint.click();true");
 await until("!Array.from(pointList.options).some(o=>o.text==='Truck')");
 console.log('PASS map and GPS creation, area replacement, offline restart, center, distance/bearing, rename and delete');
 await call('Emulation.setGeolocationOverride',{latitude:46,longitude:-122,accuracy:9});await until("document.getElementById('gps').textContent.includes('outside')");
 await js("document.getElementById('stopGps').click()");assert.equal(await js("document.getElementById('gps').textContent"),'GPS off.');
 console.log('PASS closed page, offline PWA root reopened, cached topo rendered, simulated GPS inside/outside and stop');
 outage=false;await close();
 // Several saved areas, retries, resume, and the group's cached last-known spots.
 await page(base+'offline.html');await until("document.getElementById('status')?.textContent.includes('Saved topo')");
 assert(await js("areaList.options.length>=4 && !areaPick.hidden"));
 await js("const o=[...areaList.options].find(o=>o.text.startsWith('Idaho'));areaList.value=o.value;areaList.dispatchEvent(new Event('change'));true");
 await until("document.getElementById('status').textContent.includes('Idaho · Saved topo')");
 console.log('PASS several saved areas listed and switchable');
 const count=await js("areaList.options.length");
 flaky=true;await js("choose.click();testMap.setView([43.70,-116.30],14,{animate:false});landToggle.checked=false;download.click();true");
 await until("document.getElementById('status').textContent.includes('Idaho · Saved topo')");flaky=false;
 assert(retried>0 && await js("areaList.options.length")===count+1);
 console.log('PASS transient tile failures retried ('+retried+' retries) and saved as a new area');
 const start=served;failAfter=served+40;
 await js("choose.click();testMap.setView([43.80,-116.40],14,{animate:false});landToggle.checked=false;download.click();true");
 await until("document.getElementById('status').textContent.includes('Resume download')");
 assert(await js("!resume.hidden"));
 const total=await js("progress.max"), before=served;failAfter=Infinity;
 await js("window.seen=[];new MutationObserver(()=>seen.push(document.getElementById('status').textContent)).observe(document.getElementById('status'),{childList:true,characterData:true,subtree:true});resume.click();true");
 await until("document.getElementById('status').textContent.includes('Idaho · Saved topo')");
 const kept=Number((await js("seen.find(t=>t.startsWith('Resuming'))||''")).match(/(\d+) of/)?.[1]);
 assert(kept>0 && served-before<total && served-before>=total-kept, 'kept '+kept+', resume fetched '+(served-before)+', total '+total);
 console.log('PASS interrupted download resumed: '+kept+' saved tiles kept, '+(served-before)+' of '+total+' fetched');
 await js("localStorage.setItem('huntlinkLastKnown',JSON.stringify({savedAt:Date.now(),hunters:[{name:'Test Hunter',lat:43.80,lng:-116.40,accuracy:5,time:Date.now()-7200000},{name:'Old',lat:43.80,lng:-116.40,time:Date.now()-8*3600000}]}));location.reload();true");
 await until("!groupOption.hidden && [...document.querySelectorAll('.leaflet-tooltip')].some(t=>t.textContent==='Test Hunter · last 2h ago')");
 assert(await js("![...document.querySelectorAll('.leaflet-tooltip')].some(t=>t.textContent.startsWith('Old'))"),'old hidden');
 await js("groupToggle.click();true");await until("![...document.querySelectorAll('.leaflet-tooltip')].some(t=>t.textContent.startsWith('Test Hunter'))");
 console.log('PASS cached group last-known spots shown on the offline map, expired ones hidden');
 await close();
 // A pack saved by the earlier single-area version still opens.
 const legacy=base.replace('/HuntLink/','/Legacy/');
 await page(legacy+'manifest.webmanifest');
 await js(`new Promise(async(ok,no)=>{const blob=await (await fetch('${base}tiles/x')).blob();const r=indexedDB.open('huntlink-topo:/Legacy/',1);r.onupgradeneeded=()=>{r.result.createObjectStore('meta');r.result.createObjectStore('tiles');};r.onsuccess=()=>{const tx=r.result.transaction(['meta','tiles'],'readwrite');tx.objectStore('tiles').put(blob,'14/6000/3000');tx.objectStore('meta').put({state:'Idaho',bounds:[[43.60,-116.22],[43.63,-116.18]],count:1,bytes:100,date:Date.now()},'area');tx.oncomplete=()=>{r.result.close();ok(true)};tx.onerror=no;};r.onerror=no;})`);
 await call('Page.navigate',{url:legacy+'offline.html'});
 // Only one synthetic tile is stored, so the viewer may also warn about missing tiles.
 await until("!document.getElementById('choose').hidden && document.getElementById('landNote').textContent.includes('Topo only')");
 await js("window.confirm=()=>true;document.getElementById('delete').click();true");
 await until("document.getElementById('saved').hidden && !document.getElementById('download').hidden");
 console.log('PASS earlier single-area offline pack still opens after the storage upgrade, and deletes cleanly');
 missing=true;
 await js("testMap.setView([43.615,-116.202],14,{animate:false});landToggle.checked=true;download.click();true");
 await until("document.getElementById('status').textContent.includes('incomplete')");
 await js("landToggle.click();download.click();true");
 await until("landNote.textContent.includes('Topo only')&&!landNote.hidden");
 console.log('PASS topo-only retry after a boundary-service failure');

} finally {socket.close();chrome.kill();server.closeAllConnections();server.close();}

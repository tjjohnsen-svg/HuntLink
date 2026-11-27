import { createParcelLayer, downloadPublicLand } from './public-land.js';
import { setupWaypoints } from './waypoints.js';
// The region outlines are generalized Census TIGERweb State_County polygons.
const $ = id => document.getElementById(id);
const topo = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const attribution = 'USGS The National Map';
const map = L.map('map', {minZoom: 5, maxZoom: 18}).setView([46.4,-117.4], 6);
const onlineTiles = L.tileLayer(topo, {attribution, maxNativeZoom: 16, maxZoom: 18});
const footprint = L.rectangle([[0,0],[0,0]], {color:'#9b3900',weight:3,fill:false,interactive:false});
L.control.scale({metric:false}).addTo(map);
let db, states, area, plan, localTiles, controller, viewing = false, areas = [], pending = null;
const MAX_AREAS = 12, STALL = 45000;
let watch = null, generation = 0, marker, accuracyCircle, lastPosition;

const parcels = createParcelLayer(map,L);
// Last known group spots, cached on this phone by the group map (cleared when you leave the group).
const groupLayer = L.layerGroup();
function showGroup() {
  groupLayer.eachLayer(layer=>layer.unbindTooltip()); groupLayer.clearLayers(); groupLayer.remove();
  let cache=null; try { cache=JSON.parse(localStorage.getItem('huntlinkLastKnown')); } catch {}
  const hunters=(cache?.hunters||[]).filter(h=>Number.isFinite(h.lat)&&Number.isFinite(h.lng)&&Date.now()-h.time<6*3600000);
  $('groupOption').hidden=!hunters.length;
  if (!hunters.length || !$('groupToggle').checked) return;
  groupLayer.addTo(map);
  for (const h of hunters) {
    const ageMin=Math.max(0,Math.round((Date.now()-h.time)/60000));
    const tip=document.createElement('span'); tip.textContent=h.name+' · last '+(ageMin<60?ageMin+'m':Math.floor(ageMin/60)+'h')+' ago';
    L.circleMarker([h.lat,h.lng],{radius:8,color:'#fff',weight:2,dashArray:'3 3',fillColor:'#a1887f',fillOpacity:.8}).addTo(groupLayer).bindTooltip(tip,{permanent:true,direction:'top'});
  }
}
const waypoints = setupWaypoints(map, $, () => area && L.latLngBounds(area.bounds));

// Resizing the status panel keeps the chosen area and its download message.
new ResizeObserver(()=>{
  map.off('moveend',updatePlan);
  map.invalidateSize();
  map.on('moveend',updatePlan);
}).observe($('map'));
$('waypointTool').onclick=()=>{ $('waypoints').open=!$('waypoints').open; };
$('waypoints').addEventListener('toggle',()=>{
  $('waypointTool').setAttribute('aria-expanded',String($('waypoints').open));
  if ($('waypoints').open) $('waypoints').scrollIntoView({block:'nearest'});
});

function result(request) {
  return new Promise((resolve,reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function finished(tx) {
  return new Promise((resolve,reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || Error('Storage interrupted'));
  });
}
// Several saved areas. The original single-area pack keeps id 'area' and unprefixed tile keys,
// so existing downloads keep working. New areas prefix tile keys with their id.
const prefix = id => id==='area' ? '' : id+':';
const tileRange = id => id==='area' ? IDBKeyRange.bound('0','9\uffff') : IDBKeyRange.bound(id+':',id+':\uffff');
const tileKey = (id,t) => prefix(id)+t.z+'/'+t.y+'/'+t.x;
const label = a => a.state+' · '+new Date(a.date).toLocaleDateString()+' · '+(a.bytes/1048576).toFixed(1)+' MB';
async function readAreas() {
  const tx = db.transaction(['meta','tiles']);
  const meta = tx.objectStore('meta'), tiles = tx.objectStore('tiles');
  const [keys,values,last,stalled] = await Promise.all([result(meta.getAllKeys()),result(meta.getAll()),result(meta.get('last')),result(meta.get('pending'))]);
  const found = [];
  for (let i=0;i<keys.length;i++) {
    if (keys[i]==='last' || keys[i]==='pending') continue;
    const info = {...values[i], id:keys[i]};
    if (await result(tiles.count(tileRange(info.id))) === info.count) found.push(info);
  }
  areas = found.sort((a,b)=>b.date-a.date);
  pending = stalled || null;
  listAreas();
  return areas.find(a=>a.id===last) || areas[0] || null;
}
async function readArea() { return readAreas(); }
function listAreas() {
  const list = $('areaList');
  list.replaceChildren(...areas.map(a=>new Option(label(a),a.id,false,a.id===area?.id)));
  $('areaPick').hidden = areas.length<2;
}
function rememberLast(id) { const tx=db.transaction('meta','readwrite'); tx.objectStore('meta').put(id,'last'); return finished(tx); }
function insideRing(point, ring) {
  let inside = false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [x,y] = ring[i], [x2,y2] = ring[j];
    if ((y>point.lat)!==(y2>point.lat) && point.lng < (x2-x)*(point.lat-y)/(y2-y)+x) inside = !inside;
  }
  return inside;
}
function stateAt(point) {
  return states.features.find(({geometry}) => {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some(([outer,...holes]) => insideRing(point,outer) && !holes.some(ring => insideRing(point,ring)));
  })?.properties.NAME;
}
function createPlan(center,state) {
  // A 5 km square, measured at the selected latitude.
  const box = center.toBounds(5000);
  const tiles = [];
  for (let z=12;z<=16;z++) {
    const first = map.project(box.getNorthWest(),z).divideBy(256).floor();
    const last = map.project(box.getSouthEast(),z).divideBy(256).floor();
    for (let x=first.x;x<=last.x;x++) for (let y=first.y;y<=last.y;y++) tiles.push({x,y,z});
  }
  return {state, bounds:[box.getSouthWest(),box.getNorthEast()], tiles};
}
function updatePlan() {
  if (viewing || controller || !states) return;
  const center = map.getCenter(), state = stateAt(center);
  plan = state && map.getZoom() >= 12 ? createPlan(center,state) : null;
  $('download').disabled = !plan;
  if (!plan) {
    footprint.remove();
    $('status').textContent = navigator.onLine ? 'Pan to an area in Idaho or Washington and zoom in to select it.' : 'Connect to the internet to select and download a topo area.';
    return;
  }
  footprint.setBounds(plan.bounds).addTo(map);
  const estimate = Math.ceil(plan.tiles.length*35/1024);
  const same = pending && samePlan(pending,plan);
  $('status').textContent = state+' · Outlined area is about 3 miles across. Estimated '+estimate+' MB. '
    +(same?'An interrupted download of this area will resume.':areas.length?'Saved as a new area ('+areas.length+' already on this device).':'');
}
function controls() {
  $('download').hidden = viewing || !!controller;
  $('cancel').hidden = !controller;
  $('saved').hidden = viewing || !areas.length || !!controller;
  $('resume').hidden = viewing || !pending || !!controller;
  $('choose').hidden = !viewing;
  $('waypointTool').hidden = !viewing;
  $('delete').hidden = !viewing;
  $('locate').hidden = !!controller;
  $('stopGps').hidden = watch===null;
  $('progress').hidden = !controller;
  $('landOption').hidden = !!controller || (viewing && !area?.publicLand?.length);
  $('landNote').hidden = !viewing;
}
function stopGPS() {
  generation++;
  waypoints.setFix(null);
  if (watch!==null) navigator.geolocation.clearWatch(watch);
  watch=null; marker?.remove(); accuracyCircle?.remove(); marker=null; accuracyCircle=null;
  lastPosition=null; $('stopGps').hidden=true;
}
function displayPosition(position, center) {
  const point=L.latLng(position.coords.latitude,position.coords.longitude);
  const radius=position.coords.accuracy;
  const covered=!viewing || L.latLngBounds(area.bounds).contains(point);
  if (!marker) {
    accuracyCircle=L.circle(point,{radius,color:'#1683ff',weight:1}).addTo(map);
    marker=L.circleMarker(point,{radius:7,color:'white',fillColor:'#1683ff',fillOpacity:1}).bindTooltip('You').addTo(map);
  } else { marker.setLatLng(point); accuracyCircle.setLatLng(point).setRadius(radius); }
  if (center && covered) {
    if (viewing) map.setView(point,16);
    else map.setView(point,Math.max(12,Math.min(15,map.getBoundsZoom(point.toBounds(5000)))),{animate:false});
  }
  const precision='±'+Math.round(radius*3.28084)+' ft';
  const time=new Date(position.timestamp).toLocaleTimeString();
  $('gps').textContent=covered ? 'Your location · '+precision+' · Fix at '+time+' · Private'
    : 'Your location is outside the downloaded area. '+point.lat.toFixed(5)+', '+point.lng.toFixed(5)+' · '+precision+' · Fix at '+time;
}
function startGPS(highAccuracy=true) {
  if (!navigator.geolocation) { $('gps').textContent='Location is unavailable on this device.'; return; }
  const token=++generation;
  $('stopGps').hidden=false;
  $('gps').textContent='Finding your location…';
  watch=navigator.geolocation.watchPosition(position => {
    if (token!==generation) return;
    const first=!lastPosition;
    lastPosition=position;
    waypoints.setFix(position);
    displayPosition(position, first && !controller);
  }, error => {
    if (token!==generation) return;
    stopGPS();
    if (highAccuracy && (error.code===2 || error.code===3)) startGPS(false);
    else $('gps').textContent=error.code===1?'Allow location access, then tap My location.':'No location fix. Tap My location to retry.';
  },{enableHighAccuracy:highAccuracy,maximumAge:5000,timeout:20000});
}
const SavedTiles = L.GridLayer.extend({
  createTile(coords,done) {
    const image=document.createElement('img');
    const key=tileKey(this.options.areaId,coords);
    result(db.transaction('tiles').objectStore('tiles').get(key)).then(blob => {
      if (!blob) throw Error('Missing tile');
      const url=URL.createObjectURL(blob);
      image.onload=()=>{URL.revokeObjectURL(url);done(null,image);};
      image.onerror=()=>{URL.revokeObjectURL(url);done(Error('Unreadable tile'),image);};
      image.src=url;
    }).catch(error=>done(error,image));
    return image;
  }
});
function showSaved() {
  viewing=true; listAreas(); rememberLast(area.id).catch(()=>{}); waypoints.show(); onlineTiles.remove(); footprint.remove(); localTiles?.remove();
  const bounds=L.latLngBounds(area.bounds);
  map.setMinZoom(12); map.setMaxBounds(bounds.pad(0.15));
  map.fitBounds(bounds,{maxZoom:15,animate:false});
  localTiles=new SavedTiles({areaId:area.id,bounds,noWrap:true,minZoom:12,maxNativeZoom:16,maxZoom:18,attribution}).addTo(map);
  localTiles.on('tileerror',()=>{if(viewing)$('status').textContent='A saved tile is missing or unreadable. Download this area again before leaving coverage.';});
  footprint.setBounds(bounds).addTo(map);
  parcels.remove().clearLayers();
  $('landToggle').checked=true;
  $('landLabel').textContent='Show saved public land';
  if (area.publicLand?.length) {
    parcels.addData({type:'FeatureCollection',features:area.publicLand}).addTo(map);
    $('landNote').textContent='USGS public land · Tap a shaded parcel for details. Verify hunting access locally.';
  } else {
    $('landNote').textContent=area.publicLand ? 'USGS returned no mapped public parcels in this area.'
      : 'Topo only. Download this area again with public-land boundaries to see them offline.';
  }
  $('status').textContent=area.state+' · Saved topo · '+(area.bytes/1048576).toFixed(1)+' MB · '+new Date(area.date).toLocaleDateString()+(areas.length>1?' · '+areas.length+' areas saved':'');
  if (lastPosition) displayPosition(lastPosition,false);
  else if (watch===null) $('gps').textContent='Tap My location for private GPS.';
  controls();
}
function choose() {
  parcels.remove().clearLayers();
  $('landLabel').textContent='Include public-land boundaries';
  $('landToggle').checked=true;
  viewing=false; waypoints.hide(); stopGPS(); $('gps').textContent='';
  localTiles?.remove(); map.setMaxBounds(null); map.setMinZoom(5);
  onlineTiles.addTo(map); listAreas(); controls(); updatePlan();
}
const samePlan=(a,b)=>a.state===b.state && L.latLngBounds(a.bounds).equals(L.latLngBounds(b.bounds),1e-9);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function discardPending() {
  if (!pending) return;
  const tx=db.transaction(['meta','tiles'],'readwrite'), done=finished(tx);
  tx.objectStore('tiles').delete(tileRange(pending.id)); tx.objectStore('meta').delete('pending');
  await done; pending=null;
}
async function savePending(job) {
  const tx=db.transaction('meta','readwrite'), done=finished(tx);
  tx.objectStore('meta').put(job,'pending'); await done; pending=job;
}
// Each tile gets its own timeout and up to three attempts. Tiles are saved as they arrive, so an
// interrupted download resumes where it stopped. The download only gives up after 45 s with no progress.
async function fetchTile(tile, signal) {
  let lastError;
  for (let attempt=0; attempt<3; attempt++) {
    if (attempt) await wait(attempt*1000);
    if (signal.aborted) throw Error('Interrupted');
    const request=new AbortController(), stop=()=>request.abort(), timer=setTimeout(stop,20000);
    signal.addEventListener('abort',stop);
    try {
      const response=await fetch(L.Util.template(topo,tile),{signal:request.signal,credentials:'omit'});
      if (!response.ok) throw Error('Tile unavailable');
      const blob=await response.blob();
      if (!blob.size || !blob.type.startsWith('image/')) throw Error('Tile unavailable');
      const image=new Image(), url=URL.createObjectURL(blob);
      try {
        image.src=url; await image.decode();
        if (image.naturalWidth!==256 || image.naturalHeight!==256) throw Error('Invalid tile');
      } finally { URL.revokeObjectURL(url); }
      return blob;
    } catch (error) { lastError=error; }
    finally { clearTimeout(timer); signal.removeEventListener('abort',stop); }
  }
  throw lastError;
}
async function download(resume=false) {
  if (controller) return;
  if (resume ? !pending : !plan) return;
  const active=new AbortController(); controller=active;
  let job, loadingLand=false, progressAt=Date.now(), failure;
  controls();
  const stall=setInterval(()=>{ if (Date.now()-progressAt>STALL) active.abort(); },5000);
  try {
    if (pending && (resume===true || (plan && samePlan(pending,plan) && pending.includeLand===$('landToggle').checked))) job=pending;
    else {
      await discardPending();
      if (areas.length>=MAX_AREAS) throw Object.assign(Error('Too many areas'),{full:true});
      const estimate=plan.tiles.length*35*1024;
      const quota=await navigator.storage?.estimate?.().catch(()=>null);
      if (quota?.quota && quota.usage+estimate>quota.quota*0.9) throw Object.assign(Error('Storage full'),{full:true});
      job={id:'a'+Date.now().toString(36), state:plan.state, bounds:plan.bounds.map(p=>[p.lat,p.lng]), tiles:plan.tiles,
        includeLand:$('landToggle').checked, publicLand:null, bytes:0};
      await savePending(job);
    }
    if (job.includeLand && !job.publicLand) {
      loadingLand=true;
      $('status').textContent='Downloading public-land boundaries…';
      const data=await downloadPublicLand(L.latLngBounds(job.bounds),active.signal);
      job={...job, publicLand:data.features, landBytes:data.bytes};
      await savePending(job); loadingLand=false; progressAt=Date.now();
    }
    const tx0=db.transaction('tiles');
    const [keys,blobs]=await Promise.all([result(tx0.objectStore('tiles').getAllKeys(tileRange(job.id))),result(tx0.objectStore('tiles').getAll(tileRange(job.id)))]);
    const have=new Set(keys);
    const todo=job.tiles.filter(t=>!have.has(tileKey(job.id,t)));
    let saved=job.tiles.length-todo.length, next=0, bytes=blobs.reduce((n,b)=>n+(b?.size||0),0);
    $('progress').max=job.tiles.length; $('progress').value=saved;
    $('status').textContent=(saved?'Resuming download · '+saved+' of '+job.tiles.length+' tiles already saved.':'Downloading the outlined area.')+' Keep HuntLinq open.';
    async function worker() {
      try {
        while (next<todo.length && !active.signal.aborted) {
          const tile=todo[next++];
          const blob=await fetchTile(tile,active.signal);
          bytes+=blob.size;
          if (bytes+(job.landBytes||0)>48*1048576) throw Error('Area exceeds storage limit');
          const tx=db.transaction('tiles','readwrite'), done=finished(tx);
          tx.objectStore('tiles').put(blob,tileKey(job.id,tile)); await done;
          saved++; progressAt=Date.now(); $('progress').value=saved;
        }
      } catch(error) { failure ??= error; active.abort(); }
    }
    await Promise.all([worker(),worker(),worker(),worker()]);
    if (failure || active.signal.aborted) throw failure || Error('Interrupted');
    $('cancel').disabled=true;
    const info={state:job.state,bounds:job.bounds,count:job.tiles.length,publicLand:job.publicLand??undefined,bytes:bytes+(job.landBytes||0),date:Date.now()};
    const tx=db.transaction(['meta'],'readwrite'), complete=finished(tx);
    const meta=tx.objectStore('meta'); meta.put(info,job.id); meta.delete('pending'); meta.put(job.id,'last');
    await complete;
    pending=null;
    area=await readAreas(); if (area?.id!==job.id) area=areas.find(a=>a.id===job.id)||area;
    showSaved();
  } catch(error) {
    $('status').textContent=error?.full
      ? (areas.length>=MAX_AREAS?'This device already holds '+MAX_AREAS+' saved areas. Delete one to save another.':'Not enough device storage for this area. Delete a saved area and retry.')
      : (loadingLand?'Download incomplete. Retry the boundaries or uncheck them for topo only.':'Download incomplete. Tap Resume download when you have signal; tiles already saved are kept.')
        +(areas.length?' Your saved areas are still available.':'');
  } finally {
    clearInterval(stall); controller=null; controls(); $('cancel').disabled=false;
    if (!viewing) { const message=$('status').textContent; updatePlan(); $('status').textContent=message; }
  }
}

$('locate').onclick=()=>{
  if (watch===null) startGPS();
  else if (lastPosition && Date.now()-lastPosition.timestamp<30000) displayPosition(lastPosition,true);
  else if (lastPosition) { stopGPS(); startGPS(); }
};
$('stopGps').onclick=()=>{stopGPS();$('gps').textContent='GPS off.';};
$('landToggle').onchange=()=>{
  if (viewing && area.publicLand?.length) {
    if ($('landToggle').checked) parcels.addTo(map); else parcels.remove();
  }
};
$('groupToggle').onchange=showGroup;
$('cancel').onclick=()=>controller?.abort();
$('download').onclick=()=>download();
$('choose').onclick=choose;
$('saved').onclick=async()=>{area=await readAreas();if(area)showSaved();else choose();};
$('resume').onclick=()=>{ if (pending) { if (!viewing) map.fitBounds(L.latLngBounds(pending.bounds),{animate:false}); download(true); } };
$('areaList').onchange=async()=>{ const id=$('areaList').value; await readAreas(); const pick=areas.find(a=>a.id===id); if (pick) { area=pick; showSaved(); } };
$('delete').onclick=async()=>{
  if (!confirm('Delete '+label(area)+' from this device?')) return;
  try {
    const tx=db.transaction(['meta','tiles'],'readwrite'), complete=finished(tx);
    tx.objectStore('meta').delete(area.id);tx.objectStore('tiles').delete(tileRange(area.id));
    await complete;area=await readAreas();if(area)showSaved();else choose();
  } catch { $('status').textContent='Could not delete the saved area. Try again.'; }
};
map.on('moveend',updatePlan);
window.addEventListener('pagehide',()=>{stopGPS();controller?.abort();});
try {
  const viewer=new URL('./offline.html',location.href).href;
  const registration=await navigator.serviceWorker.getRegistration(viewer) || await navigator.serviceWorker.register('./sw.js');
  // Older installations have a worker that doesn't save the offline viewer.
  if (!registration.active || !await caches.match(viewer)) {
    if (registration.active && !registration.installing && !registration.waiting) await registration.update();
    const candidate=registration.installing || registration.waiting || registration.active;
    if (!candidate) throw Error('Offline setup failed');
    await new Promise((resolve,reject)=>{
      const check=()=>{
        if(candidate.state==='activated' || candidate.state==='redundant'){
          candidate.removeEventListener('statechange',check);
          if(candidate.state==='activated')resolve();else reject(Error('Offline setup failed'));
        }
      };
      candidate.addEventListener('statechange',check);check();
    });
    if (!await caches.match(viewer)) throw Error('Offline shell unavailable');
  }
  const open=indexedDB.open('huntlink-topo:'+new URL('.',viewer).pathname,2);
  open.onupgradeneeded=()=>{for(const name of ['meta','tiles'])if(!open.result.objectStoreNames.contains(name))open.result.createObjectStore(name);};
  db=await result(open);
  states=await (await fetch('./offline-states.json')).json();
  area=await readAreas();
  showGroup();
  window.addEventListener('storage',e=>{if (!e.key || e.key==='huntlinkLastKnown') showGroup();});
  window.addEventListener('pageshow',showGroup);
  setInterval(showGroup,60000);
  if (area) showSaved(); else choose();
} catch {
  $('status').textContent='Offline storage is unavailable. Open HuntLinq online in a browser with device storage enabled and try again.';
}

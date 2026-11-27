import { setupWaypoints } from './waypoints.js';
// The region outlines are generalized Census TIGERweb State_County polygons.
const $ = id => document.getElementById(id);
const topo = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const attribution = 'USGS The National Map';
const map = L.map('map', {minZoom: 5, maxZoom: 18}).setView([46.4,-117.4], 6);
const onlineTiles = L.tileLayer(topo, {attribution, maxNativeZoom: 16, maxZoom: 18});
const footprint = L.rectangle([[0,0],[0,0]], {color:'#9b3900',weight:3,fill:false,interactive:false});
L.control.scale({metric:false}).addTo(map);
let db, states, area, plan, localTiles, controller, viewing = false;
let watch = null, generation = 0, marker, accuracyCircle;

const waypoints = setupWaypoints(map, $, () => area && L.latLngBounds(area.bounds));

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
async function readArea() {
  const tx = db.transaction(['meta','tiles']);
  const [info,count] = await Promise.all([result(tx.objectStore('meta').get('area')),result(tx.objectStore('tiles').count())]);
  return info && info.count === count ? info : null;
}
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
  $('status').textContent = state+' · Outlined area is about 3 miles across. Estimated '+estimate+' MB. '+(area?'A completed download replaces your saved area.':'');
}
function controls() {
  $('download').hidden = viewing || !!controller;
  $('cancel').hidden = !controller;
  $('saved').hidden = viewing || !area || !!controller;
  $('choose').hidden = !viewing;
  $('delete').hidden = !viewing;
  $('locate').hidden = !viewing;
  $('progress').hidden = !controller;
}
function stopGPS() {
  generation++;
  waypoints.setFix(null);
  if (watch!==null) navigator.geolocation.clearWatch(watch);
  watch=null; marker?.remove(); accuracyCircle?.remove(); marker=null; accuracyCircle=null;
  $('locate').textContent='My location';
}
function startGPS(highAccuracy=true) {
  if (!navigator.geolocation) { $('gps').textContent='Location is unavailable on this device.'; return; }
  const token=++generation;
  $('locate').textContent='Stop GPS';
  $('gps').textContent='Finding your location…';
  watch=navigator.geolocation.watchPosition(position => {
    if (token!==generation || !viewing) return;
    const point=L.latLng(position.coords.latitude,position.coords.longitude);
    const radius=position.coords.accuracy;
    waypoints.setFix(position);
    if (!marker) {
      accuracyCircle=L.circle(point,{radius,color:'#1683ff',weight:1}).addTo(map);
      marker=L.circleMarker(point,{radius:7,color:'white',fillColor:'#1683ff',fillOpacity:1}).bindTooltip('You').addTo(map);
      if (L.latLngBounds(area.bounds).contains(point)) map.setView(point,16);
    } else { marker.setLatLng(point); accuracyCircle.setLatLng(point).setRadius(radius); }
    $('gps').textContent=L.latLngBounds(area.bounds).contains(point)
      ? 'Your location · ±'+Math.round(radius*3.28084)+' ft · Fix at '+new Date(position.timestamp || Date.now()).toLocaleTimeString()+' · Private'
      : 'Your location is outside the downloaded area.';
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
    const key=coords.z+'/'+coords.y+'/'+coords.x;
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
  viewing=true; waypoints.show(); onlineTiles.remove(); footprint.remove(); localTiles?.remove();
  const bounds=L.latLngBounds(area.bounds);
  map.setMinZoom(12); map.setMaxBounds(bounds.pad(0.15));
  map.fitBounds(bounds,{maxZoom:15,animate:false});
  localTiles=new SavedTiles({bounds,noWrap:true,minZoom:12,maxNativeZoom:16,maxZoom:18,attribution}).addTo(map);
  localTiles.on('tileerror',()=>{if(viewing)$('status').textContent='A saved tile is missing or unreadable. Download this area again before leaving coverage.';});
  footprint.setBounds(bounds).addTo(map);
  $('status').textContent=area.state+' · Saved topo · '+(area.bytes/1048576).toFixed(1)+' MB · '+new Date(area.date).toLocaleDateString();
  $('gps').textContent='Tap My location for private GPS.';
  controls();
}
function choose() {
  viewing=false; waypoints.hide(); stopGPS(); $('gps').textContent='';
  localTiles?.remove(); map.setMaxBounds(null); map.setMinZoom(5);
  onlineTiles.addTo(map); controls(); updatePlan();
}
async function download() {
  if (!plan || controller) return;
  const selected=plan;
  const active=new AbortController(); controller=active;
  const entries=[];
  let next=0, bytes=0, failure;
  controls(); $('progress').max=selected.tiles.length; $('progress').value=0;
  $('status').textContent='Downloading the outlined area. Keep HuntLink open.';
  async function worker() {
    try {
      while (next<selected.tiles.length && !active.signal.aborted) {
        const tile=selected.tiles[next++];
        const response=await fetch(L.Util.template(topo,tile),{signal:active.signal,credentials:'omit'});
        if (!response.ok) throw Error('Tile unavailable');
        const blob=await response.blob();
        if (!blob.size || !blob.type.startsWith('image/')) throw Error('Tile unavailable');
        const image=new Image();
        const url=URL.createObjectURL(blob);
        try {
          image.src=url; await image.decode();
          if (image.naturalWidth!==256 || image.naturalHeight!==256) throw Error('Invalid tile');
        } finally { URL.revokeObjectURL(url); }
        bytes+=blob.size;
        if (bytes>48*1048576) throw Error('Area exceeds storage limit');
        entries.push([tile.z+'/'+tile.y+'/'+tile.x,blob]); $('progress').value=entries.length;
      }
    } catch(error) { failure ??= error; active.abort(); }
  }
  const timeout=setTimeout(()=>active.abort(),180000);
  try {
    await Promise.all([worker(),worker(),worker(),worker()]);
    if (failure || active.signal.aborted) throw failure || Error('Interrupted');
    $('cancel').disabled=true;
    // Tiles and manifest replace the previous pack together, even across a crash or quota failure.
    const info={state:selected.state,bounds:selected.bounds.map(p=>[p.lat,p.lng]),count:entries.length,bytes,date:Date.now()};
    const tx=db.transaction(['tiles','meta'],'readwrite');
    const complete=finished(tx);
    try {
      const store=tx.objectStore('tiles'); store.clear();
      for (const [key,blob] of entries) store.put(blob,key);
      tx.objectStore('meta').put(info,'area');
    } catch { tx.abort(); }
    await complete;
    area=info; showSaved();
  } catch {
    $('status').textContent='Download incomplete. Check your connection and available storage, then retry.'+(area?' Your previous area is still saved.':'');
  } finally {
    clearTimeout(timeout); controller=null; controls(); $('cancel').disabled=false;
    if (!viewing) { const message=$('status').textContent; updatePlan(); $('status').textContent=message; }
  }
}

$('locate').onclick=()=>{if(watch===null) startGPS(); else {stopGPS();$('gps').textContent='GPS off.';}};
$('cancel').onclick=()=>controller?.abort();
$('download').onclick=download;
$('choose').onclick=choose;
$('saved').onclick=async()=>{area=await readArea();if(area)showSaved();else choose();};
$('delete').onclick=async()=>{
  if (!confirm('Delete the saved topo map from this device?')) return;
  try {
    const tx=db.transaction(['meta','tiles'],'readwrite'), complete=finished(tx);
    tx.objectStore('meta').clear();tx.objectStore('tiles').clear();
    await complete;area=null;choose();
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
  const open=indexedDB.open('huntlink-topo:'+new URL('.',viewer).pathname,1);
  open.onupgradeneeded=()=>{open.result.createObjectStore('meta');open.result.createObjectStore('tiles');};
  db=await result(open);
  states=await (await fetch('./offline-states.json')).json();
  area=await readArea();
  if (area) showSaved(); else choose();
} catch {
  $('status').textContent='Offline storage is unavailable. Open HuntLink online in a browser with device storage enabled and try again.';
}

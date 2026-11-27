// A separate on-device store keeps pins independent of topo pack replacement and deletion.
export function setupWaypoints(map, $, savedBounds) {
  const layer = L.layerGroup();
  const list = $('pointList');
  let db, points = [], fix = null, expiry, picking = false, visible = false, busy = false;
  let revision = 0;

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function openStore() {
    if (!db) {
      const open = indexedDB.open('huntlink-waypoints:' + new URL('.',location.href).pathname, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('points', {keyPath:'id', autoIncrement:true});
      db = await request(open);
    }
    return db;
  }
  function selected() {
    return points.find(p => String(p.id) === list.value);
  }
  function fresh() {
    const age = Date.now() - fix?.timestamp;
    return age >= 0 && age < 30000;
  }
  function guidance() {
    const point = selected();
    let text = '';
    if (visible && point) {
      text = point.name + ' · ';
      if (!fresh()) text += 'Use My location for distance and direction.';
      else {
        const from = L.latLng(fix.coords.latitude,fix.coords.longitude);
        const meters = from.distanceTo(point);
        const yards = Math.round(meters / 0.9144);
        const distance = yards < 1760 ? yards + ' yd' : (yards / 1760).toFixed(1) + ' mi';
        const rad = Math.PI / 180;
        const dlon = (point.lng - from.lng) * rad;
        const a = from.lat * rad, b = point.lat * rad;
        const degrees = Math.atan2(Math.sin(dlon)*Math.cos(b), Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(dlon)) / rad;
        const direction = ['N','NE','E','SE','S','SW','W','NW'][Math.round((degrees + 360) / 45) % 8];
        text += meters <= fix.coords.accuracy + (point.accuracy || 0)
          ? 'Within GPS accuracy.' : distance + ' ' + direction + ' · straight line, true north.';
      }
      if (!savedBounds()?.contains(point)) text += ' Outside this saved map.';
    }
    $('returnInfo').textContent = text;
  }
  function setFix(position) {
    clearTimeout(expiry);
    fix = position;
    if (fresh()) expiry = setTimeout(guidance, 30001 - (Date.now() - fix.timestamp));
    guidance();
  }
  function select(id, center = false) {
    list.value = String(id ?? '');
    const point = selected();
    const onMap = point && savedBounds()?.contains(point);
    $('showPoint').disabled = !onMap;
    $('renamePoint').disabled = $('deletePoint').disabled = !point;
    if (onMap && center) map.setView(point,Math.max(16,map.getZoom()));
    layer.eachLayer(pin => pin.setStyle({fillColor:pin.pointId===point?.id?'#81245b':'#c26a16'}));
    guidance();
  }
  async function refresh(id = list.value) {
    const current = ++revision;
    const store = await openStore();
    const records = await request(store.transaction('points').objectStore('points').getAll());
    if (current !== revision || !visible) return;
    points = records.sort((a,b) => a.name.localeCompare(b.name) || a.id-b.id);
    layer.clearLayers();
    list.replaceChildren(new Option('Select a waypoint',''));
    for (const point of points) {
      list.add(new Option(point.name,String(point.id)));
      if (!savedBounds()?.contains(point)) continue;
      const label = document.createElement('span');
      label.textContent = point.name;
      const pin = L.circleMarker(point,{radius:8,color:'#fff',weight:2,fillOpacity:1,bubblingMouseEvents:false})
        .bindTooltip(label,{permanent:true,direction:'top'}).addTo(layer);
      pin.pointId = point.id;
      pin.on('click',() => { if (picking) mark(point,null); else { $('waypoints').open=true;select(point.id); } });
    }
    select(id);
  }
  function cancelPick() {
    picking = false;
    $('pickPoint').textContent = 'Mark on map';
    map.getContainer().style.cursor = '';
  }
  async function change(write, message, keepId) {
    if (busy) return;
    busy = true;
    try {
      const store = await openStore();
      const tx = store.transaction('points','readwrite');
      const result = write(tx.objectStore('points'));
      await new Promise((resolve,reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      await refresh(keepId ?? result.result);
      $('waypointHint').textContent = message;
    } catch { $('waypointHint').textContent = 'Could not update this waypoint. Check device storage and retry.'; }
    finally { busy=false; }
  }
  function askName(initial='') {
    const name = prompt('Waypoint name (up to 50 characters)',initial)?.trim();
    if (!name || name.length > 50) {
      if (name !== undefined) $('waypointHint').textContent='Enter a name between 1 and 50 characters.';
      return null;
    }
    return name;
  }
  function mark(point, accuracy) {
    if (busy) return;
    if (!savedBounds()?.contains(point)) {
      $('waypointHint').textContent='Choose a point inside the downloaded area.';
      return;
    }
    cancelPick(); $('waypointHint').textContent='';
    const name=askName();
    if (name) void change(store => store.add({name,lat:point.lat,lng:point.lng,accuracy}), 'Waypoint saved on this device.');
  }
  $('markGps').onclick = () => {
    cancelPick();
    if (!fresh()) { $('waypointHint').textContent='Tap My location and wait for a fresh GPS fix, then mark your position.'; return; }
    mark(L.latLng(fix.coords.latitude,fix.coords.longitude),fix.coords.accuracy);
  };
  $('pickPoint').onclick = () => {
    if (picking) { cancelPick(); $('waypointHint').textContent=''; return; }
    picking=true;
    map.getContainer().style.cursor='crosshair';
    $('pickPoint').textContent='Cancel map pick';
    $('waypointHint').textContent='Tap the truck, camp, or gate location on the saved map.';
  };
  map.on('click', e => { if (visible && picking) mark(e.latlng,null); });
  $('waypoints').ontoggle = () => { if (!$('waypoints').open && picking) { cancelPick(); $('waypointHint').textContent=''; } };
  list.onchange = () => select(list.value,true);
  $('showPoint').onclick = () => select(list.value,true);
  $('renamePoint').onclick = () => {
    const point=selected();
    if (!point || busy) return;
    const name=askName(point.name);
    if (name) void change(store => {
      const read=store.get(point.id);
      read.onsuccess=()=>{ if (read.result) store.put({...read.result,name}); else store.transaction.abort(); };
      return read;
    }, 'Waypoint renamed.',point.id);
  };
  $('deletePoint').onclick = () => {
    const point=selected();
    if (point && !busy && confirm('Delete “'+point.name+'” from this device?')) void change(store=>store.delete(point.id),'Waypoint deleted.');
  };
  function show() {
    visible=true; $('waypoints').hidden=false; layer.addTo(map);
    refresh().catch(()=>{ $('waypointHint').textContent='Could not load waypoints from this device.'; });
  }
  function hide() {
    visible=false; revision++; cancelPick(); layer.remove(); layer.clearLayers();
    $('waypoints').open=false; $('waypoints').hidden=true; $('waypointHint').textContent=''; guidance();
  }
  return {setFix,show,hide};
}

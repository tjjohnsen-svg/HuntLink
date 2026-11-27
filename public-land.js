// USGS PAD-US Fee Managers. Restrict ownership as the inventory also includes private land.
const service = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query';
// Small city and district parcels are mostly parks, school grounds and road rights-of-way, where
// hunting isn't allowed. Leaving them out keeps them from crowding BLM, Forest Service and state
// land out of a busy view near town. Federal and state parcels are always included.
const filter = "State_Nm IN ('ID','WA','MT','OR') AND Own_Type IN ('FED','STAT','LOC','DIST')"
  + " AND (Own_Type IN ('FED','STAT') OR (GIS_Acres >= 40 AND Mang_Name NOT IN ('PVT','REG','UNKL')))"
  + " AND (Loc_Nm IS NULL OR UPPER(Loc_Nm) NOT LIKE '%SCHOOL%')";
const fields = 'Loc_Nm,Unit_Nm,Loc_Mang,Mang_Name,WebServiceMangName,Pub_Access,Own_Type,Src_Date';

// PAD-US public access codes. Closed and restricted land is drawn differently so it doesn't look
// like open public land.
const ACCESS = {
  OA: 'Open to the public',
  RA: 'Restricted access (permits, seasons or closed areas may apply)',
  XA: 'Closed to the public',
  UK: 'Public access unknown'
};
const OWNER = {FED: 'Federal', STAT: 'State', LOC: 'Local government', DIST: 'Special district'};
const MANAGER = {
  BLM: 'Bureau of Land Management', USFS: 'U.S. Forest Service', FWS: 'U.S. Fish and Wildlife Service',
  NPS: 'National Park Service', USBR: 'Bureau of Reclamation', USACE: 'U.S. Army Corps of Engineers',
  DOD: 'Department of Defense', DOE: 'Department of Energy', ARS: 'Agricultural Research Service',
  BIA: 'Bureau of Indian Affairs', OTHF: 'Other federal agency', SDOL: 'State Department of Lands',
  SFW: 'State Fish and Wildlife', SPR: 'State Parks', SDNR: 'State Department of Natural Resources',
  SDC: 'State Department of Conservation', OTHS: 'Other state agency', CITY: 'City', CNTY: 'County',
  REG: 'Regional agency', UNKL: 'Unknown local agency', JNT: 'Joint management', NGO: 'Nonprofit',
  PVT: 'Private', TRIB: 'Tribal', UNK: 'Unknown'
};
export function accessOf(p) { return ACCESS[p?.Pub_Access] ? p.Pub_Access : 'UK'; }
function tidy(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  // Turn ALL-CAPS names like "BOISE INDEPENDENT SCHOOL DISTRICT" into readable title case.
  return value && value === value.toUpperCase() && /[A-Z]{3}/.test(value)
    ? value.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()) : value;
}
// Colors are chosen to stand out on each basemap and not be mistaken for the topo map's own green
// woodland tint: purple on topo, bright yellow on satellite photos. Restricted, closed and unknown
// access use dashed or dotted outlines so they read differently even in bright sun.
const PALETTES = {
  topo: {OA: '#6a1b9a', OAfill: '#ab47bc', RA: '#b35c00', XA: '#c62828', UK: '#546e7a'},
  satellite: {OA: '#ffe600', OAfill: '#ffe600', RA: '#ff9800', XA: '#ff5252', UK: '#eceff1'}
};
export function parcelStyle(feature, basemap = 'topo') {
  const c = PALETTES[basemap] || PALETTES.topo;
  switch (accessOf(feature?.properties)) {
    case 'OA': return {color: c.OA, fillColor: c.OAfill, fillOpacity: basemap === 'satellite' ? 0.22 : 0.16, weight: 3, opacity: 1, dashArray: null};
    case 'RA': return {color: c.RA, fillColor: c.RA, fillOpacity: 0.14, weight: 3, opacity: 1, dashArray: '9 5'};
    // Closed: outline only (a faint fill keeps it tappable).
    case 'XA': return {color: c.XA, fillColor: c.XA, fillOpacity: 0.06, weight: 3.5, opacity: 1, dashArray: '2 6'};
    default: return {color: c.UK, fillColor: c.UK, fillOpacity: 0.1, weight: 2.5, opacity: 1, dashArray: '6 4'};
  }
}
// A small legend that matches the current basemap's colors.
export function landLegend(basemap = 'topo') {
  const legend = document.createElement('div');
  legend.className = 'land-legend legend-' + basemap;
  for (const [code, label] of [['OA', 'Open'], ['RA', 'Restricted'], ['XA', 'Closed'], ['UK', 'Unknown']]) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    const style = parcelStyle({properties: {Pub_Access: code}}, basemap);
    swatch.style.borderColor = style.color;
    swatch.style.borderStyle = style.dashArray ? (code === 'XA' ? 'dotted' : 'dashed') : 'solid';
    swatch.style.background = code === 'OA' ? style.fillColor + '66' : 'transparent';
    item.append(swatch, document.createTextNode(label));
    legend.append(item);
  }
  return legend;
}
export function parcelPopup(p = {}) {
  const content = document.createElement('div');
  content.className = 'parcel-info';
  const line = (text, tag = 'div') => { const e = document.createElement(tag); e.textContent = text; content.append(e); return e; };
  line(tidy(p.Loc_Nm || p.Unit_Nm) || 'Public land', 'strong');
  const access = accessOf(p);
  line(ACCESS[access]).className = 'parcel-access access-' + access;
  if (OWNER[p.Own_Type]) line('Owner: ' + OWNER[p.Own_Type]);
  const code = p.Mang_Name || p.WebServiceMangName;
  const agency = MANAGER[code] || tidy(code);
  const local = tidy(p.Loc_Mang);
  const detail = local && !/^unknown$/i.test(local) && local.toUpperCase() !== String(code).toUpperCase()
    && local.toLowerCase() !== agency?.toLowerCase() ? local : '';
  line('Manager: ' + ([agency, detail].filter(Boolean).join(' · ') || 'Unlisted'));
  const year = /^(\d{4})/.exec(String(p.Src_Date ?? ''))?.[1];
  line('Source: USGS PAD-US 4.1' + (year ? ', boundary data from ' + year : '') + '.');
  line('Boundaries are approximate. Verify access and hunting rules locally.');
  return content;
}

let styled = false;
function addPopupStyle() {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = '.land-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin:2px 0 4px;font:600 13px system-ui,sans-serif}'
    + '.land-legend span{display:inline-flex;align-items:center;gap:5px}.land-legend i{width:16px;height:12px;border:3px solid;border-radius:2px;background:#0000;box-sizing:border-box}'
    + '.land-legend{background:#f4f6f3;color:#192b23;border-radius:6px;padding:4px 8px}.legend-satellite{background:#111c16;color:#fff;border:1px solid #496353}'
    + '.parcel-info{font:15px/1.4 system-ui,sans-serif;color:#192b23}.parcel-info strong{display:block;font-size:16px;margin-bottom:2px}'
    + '.parcel-access{font-weight:700}.access-XA{color:#b71c1c}.access-RA{color:#8a4500}.access-UK{color:#455a64}.access-OA{color:#1b5e20}';
  document.head.append(style);
}

export function createParcelLayer(map, L, basemap = 'topo') {
  addPopupStyle();
  const pane = map.createPane('publicLand');
  pane.style.zIndex = 390; // Below hunter markers and GPS accuracy circles.
  const layer = L.geoJSON(null, {
    pane: 'publicLand',
    attribution: '<a href="https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-web-services">USGS PAD-US</a>',
    style: feature => parcelStyle(feature, layer.basemap),
    onEachFeature(feature, parcel) {
      parcel.bindPopup(() => parcelPopup(feature.properties), {maxWidth: 280});
    }
  });
  layer.basemap = basemap;
  // Restyle for the chosen basemap ('topo' or 'satellite').
  layer.setBasemap = kind => {
    layer.basemap = kind;
    layer.setStyle(feature => parcelStyle(feature, kind));
    layer.fire('basemap');
    return layer;
  };
  return layer;
}

// Enumerate IDs first so a server result limit cannot silently truncate a saved area.
export async function downloadPublicLand(bounds, signal) {
  const spatial = {where:filter, geometry:bounds.toBBoxString(), geometryType:'esriGeometryEnvelope',
    spatialRel:'esriSpatialRelIntersects', inSR:'4326'};
  async function query(params) {
    const response = await fetch(service+'?'+new URLSearchParams(params), {signal,credentials:'omit'});
    if (!response.ok) throw Error('Parcel service unavailable');
    return response.json();
  }
  const listing = await query({...spatial,f:'json',returnIdsOnly:'true'});
  if (!Array.isArray(listing.objectIds) || listing.exceededTransferLimit) throw Error('Incomplete parcel list');
  const ids = [...new Set(listing.objectIds)];
  const features = [];
  let bytes = 0;
  for (let i=0; i<ids.length; i+=50) {
    const batch = ids.slice(i,i+50);
    const data = await query({...spatial,f:'geojson',objectIds:batch.join(','),outSR:'4326',
      outFields:fields+','+listing.objectIdFieldName,returnGeometry:'true',geometryPrecision:'6',
      maxAllowableOffset:String(360/(256*2**16))});
    const pending = new Set(batch);
    if (data.type!=='FeatureCollection' || !Array.isArray(data.features)) throw Error('Invalid parcel response');
    for (const feature of data.features) {
      if (!pending.delete(feature.properties?.[listing.objectIdFieldName] ?? feature.id) ||
          !['Polygon','MultiPolygon'].includes(feature.geometry?.type)) throw Error('Invalid parcel');
    }
    if (pending.size) throw Error('Missing parcels');
    bytes+=new Blob([JSON.stringify(data.features)]).size;
    if (bytes>12*1048576) throw Error('Parcel data too large');
    features.push(...data.features);
  }
  // Trim parcels to the saved area so the offline map doesn't draw public land past the edge
  // of the downloaded topo, and so the saved copy is smaller.
  const box = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  const clipped = features.map(feature => clipFeature(feature, box)).filter(Boolean);
  return {features: clipped, bytes: new Blob([JSON.stringify(clipped)]).size};
}

// Cut a polygon ring to a rectangle [west, south, east, north] (Sutherland-Hodgman).
function clipRing(ring, [w, s, e, n]) {
  const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const edges = [
    [p => p[0] >= w, (a, b) => at(a, b, (w - a[0]) / (b[0] - a[0]))],
    [p => p[0] <= e, (a, b) => at(a, b, (e - a[0]) / (b[0] - a[0]))],
    [p => p[1] >= s, (a, b) => at(a, b, (s - a[1]) / (b[1] - a[1]))],
    [p => p[1] <= n, (a, b) => at(a, b, (n - a[1]) / (b[1] - a[1]))]
  ];
  let points = ring.slice(0, -1);
  for (const [inside, cut] of edges) {
    const input = points;
    points = [];
    let previous = input[input.length - 1];
    for (const current of input) {
      if (inside(current)) {
        if (!inside(previous)) points.push(cut(previous, current));
        points.push(current);
      } else if (inside(previous)) points.push(cut(previous, current));
      previous = current;
    }
    if (points.length < 3) return null;
  }
  return [...points.map(p => p.map(v => Math.round(v * 1e6) / 1e6)), points[0].map(v => Math.round(v * 1e6) / 1e6)];
}
export function clipFeature(feature, box) {
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const kept = [];
  for (const [outer, ...holes] of polygons) {
    const ring = clipRing(outer, box);
    if (ring) kept.push([ring, ...holes.map(hole => clipRing(hole, box)).filter(Boolean)]);
  }
  if (!kept.length) return null;
  return {...feature, geometry: kept.length === 1 ? {type: 'Polygon', coordinates: kept[0]} : {type: 'MultiPolygon', coordinates: kept}};
}

export function addPublicLand(map, control, L, noticeBox, basemap = 'topo') {
  // Idaho, Washington, Montana and Oregon.
  const coverage = L.latLngBounds([41.98, -124.9], [49.01, -104.03]);
  const limit = 150, maxCached = 800;
  // At zoom 10 and 11 (scouting a wider area) only large federal and state parcels load, which keeps
  // each download about the same size as a closer view.
  const minZoom = 10, scoutBelow = 12;
  let request;
  let timer;
  let pending = null; // The area being loaded.
  let failed = null; // The view where loading last failed.
  // Areas already loaded this session, so panning back or toggling the layer reuses them
  // instead of downloading again. Parcels are kept by ID, so overlapping areas don't duplicate.
  let areas = [];
  const cached = new Map();
  const parcels = createParcelLayer(map, L, basemap);
  // The notice holds a small legend and one status message.
  const message = document.createElement('span');
  const showLegend = () => noticeBox.replaceChildren(landLegend(parcels.basemap), message);
  showLegend();
  parcels.on('basemap', showLegend);
  const notice = {set textContent(text) { message.textContent = text; }, get textContent() { return message.textContent; },
    set hidden(value) { noticeBox.hidden = value; }, get hidden() { return noticeBox.hidden; }};
  let added = null;
  parcels.on('layeradd', event => { added = event.layer; });
  control.addOverlay(parcels, 'Public land · ID, WA, MT & OR');
  const messages = {
    partial: 'Partial public land coverage. Zoom in for more detail. Verify hunting access locally.',
    shown: 'Outlined parcels are mapped public land. Tap one for details. Verify hunting access locally.',
    none: 'No public parcels mapped here by USGS. Ownership and access may vary.',
    scout: 'Zoomed out: only large federal and state parcels (1 square mile or more) are shown. Zoom in for all parcels.'
  };

  function stop() {
    clearTimeout(timer);
    request?.abort();
    request = null;
    pending = null;
  }
  // Turning the layer off hides it but keeps what was loaded for this session.
  function hide() {
    stop();
    notice.hidden = true;
  }
  // An area loaded zoomed out only has the large parcels, so it can't stand in for a closer view.
  const covering = (bounds, zoom) => areas.find(a => a.box.contains(bounds) && (!a.scout || zoom < scoutBelow)
    && (a.partial ? a.zoom === zoom : a.zoom >= zoom - 1));
  const parcelId = feature => feature.id ?? feature.properties?.OBJECTID ?? Symbol('parcel');

  // Only parcels near the current view are drawn; the rest wait in memory. Drawing every parcel
  // loaded during a session made each pan slower and slower on a phone.
  function showNearby() {
    const near = map.getBounds().pad(0.5);
    for (const item of cached.values()) {
      const want = near.intersects(item.bounds);
      if (want && !parcels.hasLayer(item.layer)) parcels.addLayer(item.layer);
      else if (!want && parcels.hasLayer(item.layer)) parcels.removeLayer(item.layer);
    }
  }
  function store(features, zoom) {
    for (const feature of features) {
      const id = parcelId(feature);
      const old = cached.get(id);
      // Keep the more detailed copy of a parcel.
      if (old && old.zoom >= zoom) continue;
      if (old) parcels.removeLayer(old.layer);
      added = null;
      try { parcels.addData(feature); } catch { continue; } // Skip a parcel with broken geometry.
      if (added) cached.set(id, {layer: added, zoom, bounds: added.getBounds()});
    }
    // Forget far-away parcels if a long session piles up too many.
    if (cached.size > maxCached) {
      const keep = map.getBounds().pad(1);
      for (const [id, item] of cached) {
        if (!keep.intersects(item.bounds)) { parcels.removeLayer(item.layer); cached.delete(id); }
      }
      areas = areas.filter(a => keep.intersects(a.box));
    }
    showNearby();
  }

  function update() {
    if (!map.hasLayer(parcels)) return;
    notice.hidden = false;
    showNearby();
    const bounds = map.getBounds(), zoom = map.getZoom();
    // The map also reports a "move" when the info panel under it grows or shrinks. If the view is
    // still inside an area already loaded, keep what is shown instead of reloading. Without this a
    // changing message resized the map, which reloaded the layer, in an endless loop.
    if (pending && pending.zoom === zoom && pending.box.contains(bounds)) return;
    // After a failed load, the longer message can resize the map. Only a real pan or zoom retries,
    // otherwise a resize would retry, fail and resize again in a loop.
    if (failed && failed.zoom === zoom && map.latLngToContainerPoint(failed.center).distanceTo(map.getSize().divideBy(2)) < 2) return;
    failed = null;
    const known = covering(bounds, zoom);
    if (known) { stop(); notice.textContent = known.message; return; }
    stop();
    if (!coverage.intersects(bounds)) {
      notice.textContent = 'Outside public-land coverage. HuntLinq maps public land in Idaho, Washington, Montana and Oregon only.';
      return;
    }
    if (zoom < minZoom) {
      notice.textContent = 'Zoom in to see mapped public land.';
      return;
    }
    const scout = zoom < scoutBelow;
    // Parcels already on screen stay visible while the new area loads.
    notice.textContent = 'Loading public land…';
    // Request an outward-rounded map area with some margin, so small pans and panel resizes reuse it.
    // No individual location records are sent.
    const padded = bounds.pad(0.25);
    const box = [Math.floor(padded.getWest()*100), Math.floor(padded.getSouth()*100),
      Math.ceil(padded.getEast()*100), Math.ceil(padded.getNorth()*100)].map(v => v/100);
    const target = {box: L.latLngBounds([box[1], box[0]], [box[3], box[2]]), zoom, scout};
    const pixel = 360 / (256 * 2 ** zoom);
    pending = target;
    const query = new URLSearchParams({
      f: 'geojson', where: scout ? filter + " AND Own_Type IN ('FED','STAT') AND GIS_Acres >= 640" : filter, outFields: fields + ',OBJECTID', geometry: box.join(','),
      geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326', outSR: '4326', returnGeometry: 'true', resultRecordCount: String(limit),
      // If a view still has more parcels than the limit, the largest ones come first.
      orderByFields: 'GIS_Acres DESC',
      // Simplify to about one screen pixel and send only the decimal places that pixel needs
      // (4 when zoomed out, 6 when zoomed far in). This cuts the download by about a third.
      geometryPrecision: String(Math.min(6, Math.ceil(-Math.log10(pixel / 3)))), maxAllowableOffset: String(pixel)
    });
    timer = setTimeout(async () => {
      const active = new AbortController();
      request = active;
      const timeout = setTimeout(() => active.abort(), 15000);
      try {
        const response = await fetch(service + '?' + query, {signal: active.signal, credentials: 'omit'});
        if (!response.ok) throw Error();
        const data = await response.json();
        if (request !== active) return;
        if (!Array.isArray(data.features) || data.type !== 'FeatureCollection') throw Error();
        store(data.features, zoom);
        const partial = data.features.length >= limit || !!data.exceededTransferLimit || !!data.properties?.exceededTransferLimit;
        const message = partial ? messages.partial : !data.features.length ? messages.none : scout ? messages.scout : messages.shown;
        areas.push({...target, partial, message});
        if (areas.length > 40) areas.shift();
        notice.textContent = message;
      } catch {
        if (request !== active) return;
        failed = {center: map.getCenter(), zoom};
        const visible = map.getBounds();
        notice.textContent = [...cached.values()].some(item => visible.intersects(item.bounds))
          ? 'Couldn\'t update public land (weak or no signal). Showing parcels loaded earlier; some may be missing. Move the map to retry.'
          : 'Public land unavailable. Move the map or toggle the layer to retry.';
      } finally {
        clearTimeout(timeout);
        if (request === active) { request = null; pending = null; }
      }
    }, 200);
  }

  parcels.on('add', update);
  parcels.on('remove', hide);
  map.on('moveend', () => { if (map.hasLayer(parcels)) update(); });
  return parcels;
}

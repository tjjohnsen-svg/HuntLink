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
export function parcelStyle(feature) {
  switch (accessOf(feature?.properties)) {
    case 'OA': return {color: '#275e41', fillColor: '#76ce88', fillOpacity: 0.32, weight: 2, dashArray: null};
    case 'RA': return {color: '#b35c00', fillColor: '#ffb74d', fillOpacity: 0.2, weight: 3, dashArray: '8 5'};
    // Closed: outline only (a faint fill keeps it tappable).
    case 'XA': return {color: '#c62828', fillColor: '#c62828', fillOpacity: 0.06, weight: 3, dashArray: '2 6'};
    default: return {color: '#5f6b66', fillColor: '#b0bec5', fillOpacity: 0.15, weight: 2, dashArray: '6 4'};
  }
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
  const detail = local && !/^unknown$/i.test(local) && local !== code && local.toLowerCase() !== agency?.toLowerCase() ? local : '';
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
  style.textContent = '.parcel-info{font:15px/1.4 system-ui,sans-serif;color:#192b23}.parcel-info strong{display:block;font-size:16px;margin-bottom:2px}'
    + '.parcel-access{font-weight:700}.access-XA{color:#b71c1c}.access-RA{color:#8a4500}.access-UK{color:#455a64}.access-OA{color:#1b5e20}';
  document.head.append(style);
}

export function createParcelLayer(map, L) {
  addPopupStyle();
  const pane = map.createPane('publicLand');
  pane.style.zIndex = 390; // Below hunter markers and GPS accuracy circles.
  return L.geoJSON(null, {
    pane: 'publicLand',
    attribution: '<a href="https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-web-services">USGS PAD-US</a>',
    style: parcelStyle,
    onEachFeature(feature, layer) {
      layer.bindPopup(() => parcelPopup(feature.properties), {maxWidth: 280});
    }
  });
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
  return {features,bytes};
}

export function addPublicLand(map, control, L, notice) {
  // Idaho, Washington, Montana and Oregon.
  const coverage = L.latLngBounds([41.98, -124.9], [49.01, -104.03]);
  const limit = 150;
  let request;
  let timer;
  let loaded = null; // {box, zoom} for the area already shown (or being loaded).
  const parcels = createParcelLayer(map,L);
  control.addOverlay(parcels, 'Public land · ID, WA, MT & OR');

  function stop() {
    clearTimeout(timer);
    request?.abort();
    request = null;
  }
  function reset() {
    stop();
    loaded = null;
    parcels.clearLayers();
    notice.hidden = true;
  }

  function update() {
    if (!map.hasLayer(parcels)) return;
    notice.hidden = false;
    const bounds = map.getBounds(), zoom = map.getZoom();
    // The map also reports a "move" when the info panel under it grows or shrinks. If the view is
    // still inside the area already loaded at this zoom, keep what is shown instead of reloading.
    // Without this a changing message resized the map, which reloaded the layer, in an endless loop.
    if (loaded && loaded.zoom === zoom && loaded.box.contains(bounds)) return;
    stop();
    if (!coverage.intersects(bounds)) {
      loaded = null; parcels.clearLayers();
      notice.textContent = 'Outside public-land coverage. HuntLinq maps public land in Idaho, Washington, Montana and Oregon only.';
      return;
    }
    if (zoom < 12) {
      loaded = null; parcels.clearLayers();
      notice.textContent = 'Zoom in to see mapped public land.';
      return;
    }
    // Keep the parcels already on screen while the new area loads.
    notice.textContent = 'Loading public land…';
    // Request an outward-rounded map area with some margin, so small pans and panel resizes reuse it.
    // No individual location records are sent.
    const padded = bounds.pad(0.25);
    const box = [Math.floor(padded.getWest()*100), Math.floor(padded.getSouth()*100),
      Math.ceil(padded.getEast()*100), Math.ceil(padded.getNorth()*100)].map(v => v/100);
    const target = {box: L.latLngBounds([box[1], box[0]], [box[3], box[2]]), zoom};
    loaded = target;
    const query = new URLSearchParams({
      f: 'geojson', where: filter, outFields: fields, geometry: box.join(','),
      geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326', outSR: '4326', returnGeometry: 'true', resultRecordCount: String(limit),
      // If a view still has more parcels than the limit, the largest ones come first.
      orderByFields: 'GIS_Acres DESC',
      geometryPrecision: '6', maxAllowableOffset: String(360 / (256 * 2 ** zoom))
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
        parcels.clearLayers();
        parcels.addData(data);
        if (data.features.length >= limit || data.exceededTransferLimit || data.properties?.exceededTransferLimit) {
          notice.textContent = 'Partial public land coverage. Zoom in for more detail. Verify hunting access locally.';
        } else {
          notice.textContent = data.features.length
            ? 'Green shading shows mapped public land. Tap for details. Verify hunting access locally.'
            : 'No public parcels mapped here by USGS. Ownership and access may vary.';
        }
      } catch {
        if (request !== active) return;
        if (loaded === target) loaded = null;
        notice.textContent = 'Public land unavailable. Move the map or toggle the layer to retry.';
      } finally {
        clearTimeout(timeout);
        if (request === active) request = null;
      }
    }, 200);
  }

  parcels.on('add', update);
  parcels.on('remove', reset);
  map.on('moveend', () => { if (map.hasLayer(parcels)) update(); });
  return parcels;
}

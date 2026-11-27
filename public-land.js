// USGS PAD-US Fee Managers. Restrict ownership as the inventory also includes private land.
const service = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query';
const filter = "State_Nm IN ('ID','WA') AND Own_Type IN ('FED','STAT','LOC','DIST')";
const fields = 'Loc_Nm,Unit_Nm,Loc_Mang,Mang_Name,WebServiceMangName';

export function createParcelLayer(map, L) {
  const pane = map.createPane('publicLand');
  pane.style.zIndex = 390; // Below hunter markers and GPS accuracy circles.
  return L.geoJSON(null, {
    pane: 'publicLand',
    attribution: '<a href="https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-web-services">USGS PAD-US</a>',
    style: {color: '#275e41', fillColor: '#76ce88', fillOpacity: 0.32, weight: 2},
    onEachFeature(feature, layer) {
      const p = feature.properties;
      const content = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = p.Loc_Nm || p.Unit_Nm || 'Public land';
      const manager = document.createElement('div');
      manager.textContent = 'Manager: ' + (p.Loc_Mang || p.WebServiceMangName || p.Mang_Name || 'Unlisted');
      content.append(name, manager, document.createTextNode('Source: USGS PAD-US. Verify hunting access locally.'));
      layer.bindPopup(content);
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
  const coverage = L.latLngBounds([41.98, -124.9], [49.02, -111]);
  const limit = 150;
  let request;
  let timer;
  const parcels = createParcelLayer(map,L);
  control.addOverlay(parcels, 'Public land · ID & WA');

  function reset() {
    clearTimeout(timer);
    request?.abort();
    request = null;
    parcels.clearLayers();
    notice.hidden = true;
  }

  function update() {
    reset();
    if (!map.hasLayer(parcels)) return;
    notice.hidden = false;
    const bounds = map.getBounds();
    if (!coverage.intersects(bounds)) {
      notice.textContent = 'Public land coverage: Idaho and Washington.';
      return;
    }
    if (map.getZoom() < 12) {
      notice.textContent = 'Zoom in to see mapped public land in Idaho and Washington.';
      return;
    }
    notice.textContent = 'Loading public land…';
    // Request an outward-rounded map area. No individual location records are sent.
    const box = [Math.floor(bounds.getWest()*100), Math.floor(bounds.getSouth()*100),
      Math.ceil(bounds.getEast()*100), Math.ceil(bounds.getNorth()*100)].map(v => v/100);
    const query = new URLSearchParams({
      f: 'geojson', where: filter, outFields: fields, geometry: box.join(','),
      geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326', outSR: '4326', returnGeometry: 'true', resultRecordCount: String(limit),
      geometryPrecision: '6', maxAllowableOffset: String(360 / (256 * 2 ** map.getZoom()))
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
        parcels.clearLayers();
        notice.textContent = 'Public land unavailable. Move the map or toggle the layer to retry.';
      } finally {
        clearTimeout(timeout);
      }
    }, 200);
  }

  parcels.on('add', update);
  parcels.on('remove', reset);
  map.on('moveend', () => { if (map.hasLayer(parcels)) update(); });
  return parcels;
}

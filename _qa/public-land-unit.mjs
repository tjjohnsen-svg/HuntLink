// Quick Node checks for public-land.js helpers. Synthetic shapes only; no network.
import {strict as assert} from 'node:assert';
import {clipFeature, parcelStyle, accessOf} from '../public-land.js';
const square = (x, y, d) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
const box = [0, 0, 1, 1];
const crossing = clipFeature({type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [square(0.5, 0.5, 1)]}}, box);
const xs = crossing.geometry.coordinates[0].map(p => p[0]), ys = crossing.geometry.coordinates[0].map(p => p[1]);
assert(Math.max(...xs) <= 1 && Math.max(...ys) <= 1 && Math.min(...xs) >= 0.5, 'parcel crossing the area edge is trimmed to it');
assert.equal(clipFeature({type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [square(2, 2, 1)]}}, box), null, 'parcel outside the area is dropped');
const inside = {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [square(0.2, 0.2, 0.3)]}};
assert.deepEqual(clipFeature(inside, box).geometry, inside.geometry, 'parcel inside the area is unchanged');
const multi = clipFeature({type: 'Feature', properties: {}, geometry: {type: 'MultiPolygon', coordinates: [[square(0.1, 0.1, 0.2)], [square(3, 3, 1)], [square(0.6, 0.6, 0.2)]]}}, box);
assert(multi.geometry.type === 'MultiPolygon' && multi.geometry.coordinates.length === 2, 'multi-part parcel keeps only the parts inside');
const holed = clipFeature({type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [square(-1, -1, 3), square(0.4, 0.4, 0.2)]}}, box);
assert(holed.geometry.coordinates.length === 2, 'holes (private inholdings) inside the area are kept');
assert.equal(accessOf({}), 'UK');
assert(parcelStyle({properties: {Pub_Access: 'XA'}}).dashArray && parcelStyle({properties: {Pub_Access: 'OA'}}, 'satellite').color === '#ffe600', 'access styles');
console.log('PASS public-land clipping and styles');

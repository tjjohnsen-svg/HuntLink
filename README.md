# HuntLinq
Free private GPS location sharing for hunting groups.

## Where to find things

| Work | Location |
| --- | --- |
| Group sign-in, live map and voluntary sharing | `index.html` |
| Public-land parcels and map styling | `public-land.js` |
| Offline area selection, downloads and private GPS | `offline.html`, `offline.js`, `offline-states.json` |
| Private named waypoints | `waypoints.js` |
| Offline startup and installation | `sw.js`, `manifest.webmanifest`, icons, `vendor/leaflet/` and `vendor/firebase/` (bundled SDK, see its README) |
| Firebase location and membership permissions | `database.rules.json` |
| Browser and Firebase emulator tests | [QA instructions](_qa/README.md) |
| Project requirements and release approvals | [AGENTS.md](AGENTS.md) |

GitHub Pages serves the app from the repository root. `main` tracks the release line.
Offline public-land downloads are on `codex/offline-public-land`. Earlier feature
branches are snapshots of work already incorporated into the release line.
Fetch from GitHub before comparing the release with a development branch.

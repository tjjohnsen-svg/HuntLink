# Local QA

Run the commands from the repository root. The browser runner creates a fresh temporary directory and browser profiles for each run. It uses a mock group and GPS, generated map tiles, and generated parcels. Group checks block network connections. Offline checks serve the test map locally and cut the connection to test a cold restart.

| Checks | Command | Local prerequisites |
| --- | --- | --- |
| Group map and offline maps in Chromium | `python3 _qa/run.py chrome` | Google Chrome on PATH and Node.js 22.4+ |
| Same flows in mobile-sized WebKit | `/usr/bin/python3 _qa/run.py webkit` | Linux graphical session, PyGObject, GTK 3 and WebKit2GTK 4.1 |
| Service worker cache version and public-land helpers (also run first by `run.py`) | `python3 _qa/sw_version.py` and `node _qa/public-land-unit.mjs` | Python 3 and Node.js 22+ |
| Firebase permissions | `python3 _qa/rules.py /path/to/firebase-database-emulator.jar` | Java and the Firebase Realtime Database emulator JAR |
| Multi-user group map against the Firebase emulators (about 5 minutes) | `npx firebase-tools emulators:start --only auth,database --project demo-huntlink`, then in another shell `node _qa/emulator-e2e.mjs` | Java, Node.js 22+, Google Chrome and `npm i playwright` |

Use `/usr/bin/python3 _qa/run.py` to run both browsers. On an X11 system with graphics issues, prefix the WebKit command with `env GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1`.

The group tests cover the privacy page link, the Who can see you note in the Hunters list, the optional auto-stop sharing timer (it ends sharing on time and never resumes after it ends), sign-in (including the name helper text and that the group password is never stored on the phone), voluntary sharing, GPS freshness, peer distance and direction, pause and resume, and leaving the group. The offline tests cover area selection, cached topo and public-land boundaries, private GPS, and waypoints. Chromium also exercises interrupted downloads and verifies that the previous map survives.

The rules test starts a local emulator with generated credentials. It exercises the current rules and legacy timestamp compatibility. Browser simulations do not verify physical-phone GPS reception or a live deployment.

The group tests also cover the stationary heartbeat, weak-GPS handling during timeouts, the single status bar, hunter colors, initials and distances, in-place list updates, last-known spots kept for 6 hours, the on-device cache for the offline map, and the kept-awake screen. The offline tests also cover several saved areas, tile retries, resuming an interrupted download, the group's cached spots on the offline map, and opening a pack saved by the earlier single-area version.

The emulator test copies the checkout to a temporary folder and points the copy at `127.0.0.1`, so it never writes to the production database. It runs two to five simulated phones and checks bundled Leaflet and Firebase with the CDNs blocked, the heartbeat for a hunter who isn't moving, returning after a reload (login again with the name filled in, membership dropped until the password is entered, sharing paused until then and resumed after), last-known spots after a hunter loses signal, the 6-hour cleanup rule, GPS timeouts, opening without signal (login points to the offline maps, which open without the password), a changed group password, leaving the group, and the load-failure message.

If `google-chrome --dump-dom` stalls in a headless container, load `group.html` from the prepared folder in Playwright and read the page title instead.

After changing any file the service worker caches (for example `public-land.js`, `offline.js` or `map-nav.css`), run `python3 _qa/sw_version.py --update`. It bumps the cache version in `sw.js` so installed phones download the new files; `run.py` fails until you do.

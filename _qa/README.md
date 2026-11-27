# Local QA

Run the commands from the repository root. The browser runner creates a fresh temporary directory and browser profiles for each run. It uses a mock group and GPS, generated map tiles, and generated parcels. Group checks block network connections. Offline checks serve the test map locally and cut the connection to test a cold restart.

| Checks | Command | Local prerequisites |
| --- | --- | --- |
| Group map and offline maps in Chromium | `python3 _qa/run.py chrome` | Google Chrome on PATH and Node.js 22.4+ |
| Same flows in mobile-sized WebKit | `/usr/bin/python3 _qa/run.py webkit` | Linux graphical session, PyGObject, GTK 3 and WebKit2GTK 4.1 |
| Firebase permissions | `python3 _qa/rules.py /path/to/firebase-database-emulator.jar` | Java and the Firebase Realtime Database emulator JAR |

Use `/usr/bin/python3 _qa/run.py` to run both browsers. On an X11 system with graphics issues, prefix the WebKit command with `env GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1`.

The group tests cover sign-in, voluntary sharing, GPS freshness, peer distance and direction, pause and resume, and leaving the group. The offline tests cover area selection, cached topo and public-land boundaries, private GPS, and waypoints. Chromium also exercises interrupted downloads and verifies that the previous map survives.

The rules test starts a local emulator with generated credentials. It exercises the current rules and legacy timestamp compatibility. Browser simulations do not verify physical-phone GPS reception or a live deployment.

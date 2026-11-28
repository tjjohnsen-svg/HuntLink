"""Run the browser checks against an isolated copy of this checkout."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

QA = Path(__file__).resolve().parent
ROOT = QA.parent


def parcels(count, lat, lng):
    features = []
    for i in range(count):
        x, y = lng + (i % 10) * .001, lat + (i // 10) * .001
        ring = [[x, y], [x+.001, y], [x+.001, y+.001], [x, y+.001], [x, y]]
        features.append({
            'type': 'Feature',
            'properties': {'OBJECTID': i+1, 'Loc_Nm': f'Test parcel {i+1}', 'Mang_Name': 'Test agency'},
            'geometry': {'type': 'Polygon', 'coordinates': [ring]},
        })
    return features


def prepare(work):
    for name in ('offline.html', 'privacy.html', 'map-nav.css', 'offline.js', 'public-land.js', 'waypoints.js', 'good-shit.js', 'sw.js',
                 'offline-states.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'):
        shutil.copy(ROOT/name, work/name)
    shutil.copytree(ROOT/'vendor', work/'vendor')
    # Generate a solid 256px tile without a graphics dependency.
    import struct
    import zlib
    def chunk(kind, data):
        return struct.pack('>I', len(data))+kind+data+struct.pack('>I', zlib.crc32(kind+data))
    tile = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 256,256,8,0,0,0,0))
            + chunk(b'IDAT', zlib.compress(bytes(257*256))) + chunk(b'IEND', b''))
    (work/'tile').write_bytes(tile)
    for state, rows in [('ID', parcels(75,43.615,-116.202)), ('WA', parcels(29,47.04,-122.90))]:
        (work/f'parcels-{state}.json').write_text(json.dumps(rows))

    page = (ROOT/'index.html').read_text()
    header, module = page.split('<script type="module">', 1)
    header = re.sub('<link[^>]+(?:manifest|icon)[^>]*>', '', header)
    header = header.replace('https://unpkg.com/leaflet@1.9.4/dist/', './vendor/leaflet/')
    policy = "default-src 'none'; script-src 'self' 'unsafe-inline' file:; style-src 'self' 'unsafe-inline' file:; img-src data:; connect-src 'none'"
    header = header.replace('<head>', f'<head><meta http-equiv="Content-Security-Policy" content="{policy}">')
    module = 'const auth='+module.split('const auth=', 1)[1].split('</script>', 1)[0]
    module = re.sub(r"https://basemap[^']+", 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', module)
    layer = (ROOT/'public-land.js').read_text().replace('export ', '')
    scripts = [(QA/'firebase-mock.js').read_text(), layer,
               (ROOT/'good-shit.js').read_text().split('\n',1)[1].replace('export ', ''), module, (QA/'group-checks.js').read_text()]
    (work/'group.html').write_text(header+'<script>(async()=>{try{\n'+'\n'.join(scripts)
                                  +"\n}catch(e){document.title='FAIL '+e.message}})()</script>")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('engine', choices=['chrome', 'webkit', 'both'], default='both', nargs='?')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='huntlink-qa-') as directory:
        work = Path(directory)
        prepare(work)
        subprocess.run([os.sys.executable, QA/'sw_version.py'], check=True, timeout=30)
        subprocess.run(['node', QA/'public-land-unit.mjs'], check=True, timeout=30)
        if args.engine in ('chrome', 'both'):
            command = ['google-chrome','--headless','--disable-background-networking','--disable-gpu',
                       f'--user-data-dir={work}/chrome-group','--window-size=412,915',
                       '--virtual-time-budget=30000','--dump-dom',(work/'group.html').as_uri()]
            result = subprocess.run(command, capture_output=True, text=True, check=True, timeout=60)
            title = re.search(r'<title>(.*?)</title>', result.stdout)
            if not title or not title[1].startswith('PASS '):
                raise SystemExit(title[1] if title else 'Group checks did not finish')
            print(title[1], flush=True)
            subprocess.run(['node', QA/'offline-chrome.mjs'], cwd=work, check=True, timeout=120)
        if args.engine in ('webkit', 'both'):
            for script in ('group-webkit.py', 'offline-webkit.py'):
                subprocess.run([os.sys.executable, QA/script], cwd=work, check=True, timeout=75)


if __name__ == '__main__':
    main()

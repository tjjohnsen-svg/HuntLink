"""Make sure phones get updated offline files.

The service worker (sw.js) keeps a copy of the offline files and only replaces them when sw.js
itself changes. This check hashes every file sw.js caches and compares it with the hash written
in sw.js. If a cached file changed, it fails and asks you to run it with --update, which bumps
the cache version and records the new hash.

    python3 _qa/sw_version.py            # check
    python3 _qa/sw_version.py --update   # bump the version after changing a cached file
"""
import hashlib
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
SW = ROOT/'sw.js'


def cached_files(text):
    block = text.split('const files', 1)[1].split('];', 1)[0]
    names = re.findall(r"'([\w./-]+\.(?:html|css|js|json|png|webmanifest))'", block)
    paths = []
    for name in names:
        path = ROOT/name
        if not path.exists():
            path = ROOT/'vendor/leaflet/images'/name
        if not path.exists():
            raise SystemExit(f'sw.js caches {name}, but the file is missing')
        paths.append(path)
    return paths


def files_hash(text):
    digest = hashlib.sha256()
    for path in cached_files(text):
        digest.update(path.relative_to(ROOT).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()[:16]


def main():
    text = SW.read_text()
    current = files_hash(text)
    recorded = re.search(r'// Cached files hash: (\w+)', text)
    version = re.search(r"huntlink-offline-topo-v(\d+)", text)
    if '--update' in sys.argv:
        if recorded and recorded[1] == current:
            print('sw.js is already up to date (v'+version[1]+')')
            return
        bumped = int(version[1]) + 1
        text = text.replace(version[0], f'huntlink-offline-topo-v{bumped}', 1)
        line = f'// Cached files hash: {current}. Run python3 _qa/sw_version.py --update after changing a cached file.'
        text = re.sub(r'// Cached files hash: .*', line, text) if recorded else line + '\n' + text
        SW.write_text(text)
        print(f'sw.js cache version bumped to v{bumped}')
        return
    if not recorded or recorded[1] != current:
        raise SystemExit('A file the service worker caches changed. Run: python3 _qa/sw_version.py --update')
    print('PASS service worker cache version matches the cached files (v'+version[1]+')')


if __name__ == '__main__':
    main()

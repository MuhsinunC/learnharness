#!/bin/bash
# JSON lines keep spaces, backslashes and control characters unambiguous.
set -euo pipefail
python3 - "$@" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

mode, root, manifest = sys.argv[1:]
root = Path(root)
entries = {}
for path in [root, *sorted(root.rglob('*'))]:
    info = path.lstat()
    kind = 'f' if stat.S_ISREG(info.st_mode) else 'd' if stat.S_ISDIR(info.st_mode) else 'l'
    digest = hashlib.sha256(path.read_bytes()).hexdigest() if kind == 'f' else '-'
    entries[str(path.relative_to(root))] = [kind, format(stat.S_IMODE(info.st_mode), '03o'), digest]
if mode == 'write':
    with open(manifest, 'w') as out:
        for name, value in sorted(entries.items()):
            out.write(json.dumps([name, *value]) + '\n')
else:
    assert mode in ('subset', 'exact'), mode
    with open(manifest) as src:
        expected = {row[0]: row[1:] for row in map(json.loads, src)}
    for name, value in expected.items():
        assert entries.get(name) == value, f'Changed seeded entry: {name}'
    additions = sorted(entries.keys() - expected.keys())
    if mode == 'exact':
        assert not additions, f'Unexpected entries: {additions}'
    else:
        for name in additions:
            print(json.dumps(name))
PY

#!/bin/bash
# JSON lines keep spaces, backslashes and control characters unambiguous.
set -euo pipefail
python3 - "$@" <<'PY'
import hashlib
import json
import stat
import sys
from pathlib import Path

mode, root, manifest, *allowed = sys.argv[1:]
assert mode == 'subset' or not allowed, 'Extra arguments require subset mode'
root = Path(root)
expected = {}
if mode != 'write':
    assert mode in ('subset', 'exact'), mode
    with open(manifest) as src:
        expected = {row[0]: row[1:] for row in map(json.loads, src)}
for name in allowed:
    assert name in expected and expected[name][0] == 'f', f'Not a seeded regular file: {name}'
# Enumerate additions by name only: live Chromium cache files can disappear or
# change between enumeration and hashing. Only seeded entries are compared.
paths = {str(p.relative_to(root)) for p in root.rglob('*')} | {'.'}
entries = {}
for name in sorted(paths if mode == 'write' else expected):
    path = root / name
    info = path.lstat()
    kind = 'f' if stat.S_ISREG(info.st_mode) else 'd' if stat.S_ISDIR(info.st_mode) else 'l'
    digest = hashlib.sha256(path.read_bytes()).hexdigest() if kind == 'f' else '-'
    entries[str(path.relative_to(root))] = [kind, format(stat.S_IMODE(info.st_mode), '03o'), digest]
if mode == 'write':
    with open(manifest, 'w') as out:
        for name, value in sorted(entries.items()):
            out.write(json.dumps([name, *value]) + '\n')
else:
    for name, value in expected.items():
        if name in allowed:
            assert entries[name][:2] == value[:2], f'Changed seeded entry kind or mode: {name}'
            if entries[name][2] != value[2]:
                print(f'allowed change: {name}', file=sys.stderr)
        else:
            assert entries.get(name) == value, f'Changed seeded entry: {name}'
    additions = sorted(paths - expected.keys())
    if mode == 'exact':
        assert not additions, f'Unexpected entries: {additions}'
    else:
        for name in additions:
            print(json.dumps(name))
PY

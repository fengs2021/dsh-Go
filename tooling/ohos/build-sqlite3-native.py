#!/usr/bin/env python3
"""Build the SQLite shared library the Dart side loads by name, for OpenHarmony.

`package:sqlite3` ships no `.so`: its build hook hands the app a code asset that the
Dart code opens with `DynamicLibrary`-style lookup by name (`libsqlite3.so`), and the
AOT build records it in `flutter_assets/NativeAssetsManifest.json`. The default hook
path downloads a desktop build (glibc `libm.so.6` / `ld-linux-aarch64.so.1`), which
this app cannot load, so we cross-compile the amalgamation against the OpenHarmony SDK
and hand the result to the AOT directory the packaging step reads.

The defines mirror `package:sqlite3`'s own defaults
(`lib/src/hook/compile/description.dart`, `_defaultDefines`), minus
`SQLITE_HAVE_LOCALTIME_S`, which is a Windows CRT function.

Usage:
  build-sqlite3-native.py --sdk /root/sdk/native --output <aot>/native_assets/libs/arm64-v8a
  build-sqlite3-native.py --sdk /root/sdk/native --output out --archive sqlite-amalgamation-3540100.zip
"""

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

# Pinned input: the SQLite amalgamation the desktop hook would have used for this line.
URL = 'https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip'
SHA256 = '0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9'
NAME = 'libsqlite3.so'

DEFINES = [
    'SQLITE_ENABLE_DBSTAT_VTAB',
    'SQLITE_ENABLE_FTS5',
    'SQLITE_ENABLE_RTREE',
    'SQLITE_ENABLE_MATH_FUNCTIONS',
    'SQLITE_DQS=0',
    'SQLITE_DEFAULT_MEMSTATUS=0',
    'SQLITE_TEMP_STORE=2',
    'SQLITE_MAX_EXPR_DEPTH=0',
    'SQLITE_STRICT_SUBTYPE=1',
    'SQLITE_OMIT_AUTHORIZATION',
    'SQLITE_OMIT_DECLTYPE',
    'SQLITE_OMIT_DEPRECATED',
    'SQLITE_OMIT_PROGRESS_CALLBACK',
    'SQLITE_OMIT_SHARED_CACHE',
    'SQLITE_OMIT_TCL_VARIABLE',
    'SQLITE_USE_ALLOCA',
    'SQLITE_ENABLE_SESSION',
    'SQLITE_ENABLE_PREUPDATE_HOOK',
    'SQLITE_UNTESTABLE',
    'SQLITE_HAVE_ISNAN',
    'SQLITE_HAVE_LOCALTIME_R',
    'SQLITE_HAVE_MALLOC_USABLE_SIZE',
    'SQLITE_HAVE_STRCHRNUL',
    'SQLITE_ENABLE_BATCH_ATOMIC_WRITE',
]


def die(message):
    sys.exit('build-sqlite3-native: ' + message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(destination):
    request = urllib.request.Request(URL, headers={'User-Agent': 'dsh-go-ohos-build'})
    with urllib.request.urlopen(request, timeout=180) as response, destination.open('wb') as handle:
        shutil.copyfileobj(response, handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--sdk', type=Path, required=True, help='OpenHarmony native SDK (holds llvm/bin and sysroot)')
    parser.add_argument('--output', type=Path, required=True, help='directory to write libsqlite3.so into')
    parser.add_argument('--archive', type=Path, help='already-downloaded amalgamation zip, to stay offline')
    args = parser.parse_args()

    clang = args.sdk / 'llvm' / 'bin' / 'clang'
    strip = args.sdk / 'llvm' / 'bin' / 'llvm-strip'
    sysroot = args.sdk / 'sysroot'
    for tool in (clang, strip):
        if not tool.is_file():
            die(f'no such tool: {tool}')

    with tempfile.TemporaryDirectory(prefix='sqlite3-ohos-') as temp:
        work = Path(temp)
        archive = args.archive or work / 'amalgamation.zip'
        if args.archive is None:
            fetch(archive)
        digest = sha256(archive)
        if digest != SHA256:
            die(f'{archive} is sha256 {digest}, expected {SHA256}')
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(work)
        sources = sorted(work.glob('sqlite-amalgamation-*/sqlite3.c'))
        if len(sources) != 1:
            die(f'expected one sqlite3.c in {archive}, found {len(sources)}')

        built = work / NAME
        command = [str(clang), '--target=aarch64-linux-ohos', f'--sysroot={sysroot}',
                   '-fPIC', '-O2', '-shared', f'-Wl,-soname,{NAME}',
                   *[f'-D{define}' for define in DEFINES], '-o', str(built), str(sources[0])]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            die('clang failed:\n' + (result.stderr or result.stdout))

        subprocess.run([str(strip), '--strip-unneeded', str(built)], check=True)
        digests = subprocess.run([str(args.sdk / 'llvm' / 'bin' / 'llvm-readelf'), '-d', str(built)],
                                 capture_output=True, text=True).stdout
        needed = sorted(line.split('[')[1].rstrip(']') for line in digests.splitlines() if 'NEEDED' in line)
        if needed != ['libc.so']:
            die(f'{NAME} should need libc.so alone on OpenHarmony, it needs {needed}')

        args.output.mkdir(parents=True, exist_ok=True)
        shutil.copy2(built, args.output / NAME)

    written = args.output / NAME
    print(f'{written}: {written.stat().st_size} bytes, sha256 {sha256(written)}')


if __name__ == '__main__':
    main()


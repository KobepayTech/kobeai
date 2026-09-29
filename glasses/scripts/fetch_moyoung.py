"""Fetch the unchanged MoYoung 1.3.6 core AAR from its publisher, verifying both hashes.
The package declares GPL-3.0. See android/MOYOUNG.md before distributing binaries.
"""
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

URL = 'https://pub.dev/api/archives/moyoung_glasses_ble_plugin-1.3.6.tar.gz'
ARCHIVE_SHA256 = '4d2aaf0360c64af6b67f959460fff6bda808de207c27cd775961841f9be22dc3'
SDK_SHA256 = '6aae64435aaa10b7c6b63b2783068d5de23b443f00636e2cd3903142472c0c86'
DEST = Path(__file__).resolve().parents[1] / 'android/app/libs/moyoung_glasses_sdk_0.0.7_20260624.aar'


def main():
    with urllib.request.urlopen(URL, timeout=90) as response:
        archive = response.read(64 * 1024 * 1024 + 1)
    if hashlib.sha256(archive).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError('MoYoung archive checksum mismatch')
    extras = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        members = [m for m in tar.getmembers() if m.isfile() and m.name.endswith('/my_galsses_sdk_0.0.7_20260624_release.aar')]
        if len(members) != 1:
            raise RuntimeError('Expected one core SDK')
        source = tar.extractfile(members[0])
        if source is None:
            raise RuntimeError('Missing core SDK')
        sdk = source.read()
        dependencies = {
            'jl_audio_decode_V2.1.0_20012-release.aar': '4d808c11e9f16c0f69e1eefbeff3be5b4f0d67dfa25ca78ff996df925b3b56cf',
            'jl_bt_ota_V1.10.0_10932-release.aar': '7b0671e4f98b39537ed1a0701fcd0aecd16c17eebc43468fa58f17af0e84ee15',
        }
        for name, checksum in dependencies.items():
            member = tar.extractfile('android/libs/' + name)
            if member is None:
                raise RuntimeError('Missing SDK dependency: ' + name)
            data = member.read()
            if hashlib.sha256(data).hexdigest() != checksum:
                raise RuntimeError('SDK dependency checksum mismatch: ' + name)
            extras[name] = data
    if hashlib.sha256(sdk).hexdigest() != SDK_SHA256:
        raise RuntimeError('MoYoung SDK checksum mismatch')
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_bytes(sdk)
    for name, data in extras.items():
        (DEST.parent / name).write_bytes(data)
    print('Verified MoYoung SDK and its referenced Jieli runtime libraries ready.')


if __name__ == '__main__':
    main()

"""Fetch the MoYoung 1.3.8 Android SDK from the official published package.

The published archive digest is verified against pub.dev's version metadata.
Only the 1.3.8 package is accepted. No binary is committed to this repository.
This does not grant distribution rights; see android/MOYOUNG.md.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request

VERSION = "1.3.8"
SDK_RELEASE = "1.0.0_20260928"
BASE = "https://pub.dev"
ARCHIVE_URL = f"{BASE}/api/archives/moyoung_glasses_ble_plugin-{VERSION}.tar.gz"
METADATA_URL = f"{BASE}/api/packages/moyoung_glasses_ble_plugin/versions/{VERSION}"
LIBS = Path(__file__).resolve().parents[1] / "android/app/libs"
SDK_DEST = LIBS / f"moyoung_glasses_sdk_{SDK_RELEASE}.aar"
# Old core SDK cannot coexist with the new one.
OLD_CORE = LIBS / "moyoung_glasses_sdk_0.0.7_20260624.aar"
MAX_ARCHIVE = 80 * 1024 * 1024
MAX_AAR = 32 * 1024 * 1024


def fetch(url: str, limit: int) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "K9-SDK-Pin/1.3.8"}), timeout=90) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError(f"Publisher file exceeds expected size: {url}")
    return data


def main() -> None:
    meta = json.loads(fetch(METADATA_URL, 2 * 1024 * 1024))
    expected = meta.get("archive_sha256")
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
        raise RuntimeError("Published MoYoung 1.3.8 archive SHA-256 missing; refusing unverified download")
    archive = fetch(ARCHIVE_URL, MAX_ARCHIVE)
    actual = hashlib.sha256(archive).hexdigest()
    if actual.lower() != expected.lower():
        raise RuntimeError("MoYoung 1.3.8 publisher archive checksum mismatch")

    files: dict[str, bytes] = {}
    sdk_count = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            name = member.name.lstrip("./")
            if not name.startswith("android/libs/") or not name.endswith(".aar"):
                continue
            filename = Path(name).name
            if filename != name.split("/")[-1] or not re.fullmatch(r"[A-Za-z0-9_.-]+\\.aar", filename):
                raise RuntimeError("Unexpected AAR filename")
            stream = tar.extractfile(member)
            if stream is None or member.size > MAX_AAR:
                raise RuntimeError(f"Missing or oversized SDK dependency: {filename}")
            data = stream.read(MAX_AAR + 1)
            if len(data) != member.size:
                raise RuntimeError(f"Truncated SDK dependency: {filename}")
            if filename.startswith("my_galsses_sdk_"):
                if filename != f"my_galsses_sdk_{SDK_RELEASE}_release.aar":
                    raise RuntimeError(f"Unexpected core SDK version: {filename}")
                sdk_count += 1
                filename = SDK_DEST.name
            if filename in files:
                raise RuntimeError(f"Duplicate SDK dependency: {filename}")
            files[filename] = data

    if sdk_count != 1:
        raise RuntimeError(f"Expected one {SDK_RELEASE} core SDK; found {sdk_count}")
    if "lib-awlicense-1.0.1-release.aar" not in files:
        raise RuntimeError("Missing new 1.0.0 SDK authorization runtime")
    LIBS.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (LIBS / name).write_bytes(data)
    OLD_CORE.unlink(missing_ok=True)
    manifest = {
        "publisher": "pub.dev",
        "package": "moyoung_glasses_ble_plugin",
        "version": VERSION,
        "archive_sha256": actual,
        "sdk_release": SDK_RELEASE,
        "files_sha256": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())},
    }
    (LIBS / "moyoung-verified.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Verified MoYoung {VERSION}, core SDK {SDK_RELEASE}, {len(files)} AARs from publisher archive")


if __name__ == "__main__":
    main()

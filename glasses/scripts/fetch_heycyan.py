"""Fetch an unchanged, pinned proprietary SDK for a local build, never into git.
Commercial redistribution still requires the vendor's licence.
"""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile

REVISION = "f76a8bf40928d96387d1cc28984e7a29a9cd7ad1"
SDK = "glasses_sdk_20250723_v01.aar"
DEST = Path(__file__).resolve().parents[1] / "android/app/libs" / SDK


def main():
    with tempfile.TemporaryDirectory(prefix="kobe-heycyan-") as tmp:
        subprocess.run(["git", "clone", "--no-checkout", "https://github.com/ebowwa/HeyCyanSmartGlassesSDK.git", tmp], check=True)
        subprocess.run(["git", "-C", tmp, "checkout", REVISION, "--", "android/" + SDK], check=True)
        source = Path(tmp) / "android" / SDK
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        if actual != SHA256:
            raise RuntimeError("SDK checksum mismatch")
        DEST.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, DEST)
    print("Pinned HeyCyan AAR ready. Check vendor licensing before distributing an APK.")


SHA256 = "10b88d83b21a97235e264751362605ce94d3d686395f98cd47a9964aff48f8c3"
if __name__ == "__main__":
    main()

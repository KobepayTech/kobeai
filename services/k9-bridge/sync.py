#!/usr/bin/env python3
"""Continuously sync K-9 LAN inventory into KobeAI.

This bridge deliberately uses K-9's machine-readable one-shot scanner and never
invokes K-9's credential-testing or other active security-audit tiers. Those
remain manual, authorization-gated actions in the local K-9 dashboard.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

K9_ROOT = Path(os.getenv("K9_ROOT", "/k9"))
KOBEAI_BASE_URL = os.getenv("KOBEAI_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
K9_SHARED_SECRET = os.getenv("K9_SHARED_SECRET", "").strip()
SYNC_INTERVAL = max(30, int(os.getenv("K9_SYNC_INTERVAL_SECONDS", "300")))
SCAN_MODE = os.getenv("K9_SCAN_MODE", "quick").strip().lower()
NETWORK = os.getenv("K9_NETWORK", "").strip()


def scan_once() -> dict:
    launcher = K9_ROOT / "k9.py"
    if not launcher.exists():
        raise RuntimeError(f"K-9 launcher not found at {launcher}")

    cmd = [sys.executable, str(launcher), "--json", "-", "--quiet"]
    if NETWORK:
        cmd.extend(["--net", NETWORK])
    if SCAN_MODE == "deep":
        cmd.append("--deep")
    elif SCAN_MODE == "unhide":
        cmd.append("--unhide")
    elif SCAN_MODE != "quick":
        raise RuntimeError("K9_SCAN_MODE must be quick, deep, or unhide")

    proc = subprocess.run(
        cmd,
        cwd=str(K9_ROOT),
        capture_output=True,
        text=True,
        timeout=max(120, SYNC_INTERVAL - 5),
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"K-9 scan failed ({proc.returncode}): {proc.stderr[-2000:]}")
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"K-9 returned invalid JSON: {proc.stdout[-1000:]}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("devices"), list):
        raise RuntimeError("K-9 JSON did not contain a devices list")
    return payload


def sync(payload: dict) -> None:
    if not K9_SHARED_SECRET:
        raise RuntimeError("K9_SHARED_SECRET is required")
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{KOBEAI_BASE_URL}/api/v1/network-discovery/k9/sync",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-k9-secret": K9_SHARED_SECRET,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8", errors="replace")
            if response.status >= 300:
                raise RuntimeError(f"KobeAI sync rejected: HTTP {response.status} {body[:1000]}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"KobeAI sync rejected: HTTP {exc.code} {body[:1000]}") from exc


def main() -> int:
    once = os.getenv("K9_SYNC_ONCE", "").lower() in {"1", "true", "yes"}
    while True:
        started = time.time()
        try:
            payload = scan_once()
            sync(payload)
            cameras = sum(
                1
                for d in payload.get("devices", [])
                if d.get("category") == "camera"
                or any(f in {"CAMERA", "CAMERA?", "SURVEILLANCE"} for f in d.get("flags", []))
            )
            print(
                f"K-9 sync ok: {len(payload.get('devices', []))} devices, "
                f"{cameras} camera/NVR candidates",
                flush=True,
            )
        except Exception as exc:
            print(f"K-9 sync failed: {exc}", file=sys.stderr, flush=True)
            if once:
                return 1

        if once:
            return 0
        elapsed = time.time() - started
        time.sleep(max(5, SYNC_INTERVAL - elapsed))


if __name__ == "__main__":
    raise SystemExit(main())

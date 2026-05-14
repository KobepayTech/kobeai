#!/usr/bin/env python3
"""
KobeAI Tap-Box Daemon
=====================

Runs on a Raspberry Pi sitting next to a school printer. Two responsibilities:

1. Watch the USB NFC reader. When a student taps their watch, capture the
   payload the watch transmitted via HCE and POST it to the KobeAI API to
   create a pairing.

2. Long-poll the API for print jobs queued for this printer. When one
   appears, download the PDF and pipe it to the local CUPS queue.

Hardware tested:
    Raspberry Pi Zero 2 W + ACR122U USB NFC reader

Configuration is via environment variables — see /etc/default/kobeai-tap-box
in the installer.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Optional

import requests

# nfcpy is the canonical Python lib for ACR122 / PN532 readers.
try:
    import nfc  # type: ignore
    import nfc.tag  # type: ignore
except ImportError:  # pragma: no cover - allows --simulate without the lib
    nfc = None  # type: ignore

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Config:
    api_base: str
    tap_box_id: str
    printer_id: str
    cups_printer: str
    secret: str
    nfc_path: str
    poll_interval_s: float
    request_timeout_s: float

    @classmethod
    def from_env(cls) -> "Config":
        def req(name: str) -> str:
            v = os.environ.get(name)
            if not v:
                sys.exit(f"FATAL: env var {name} is required")
            return v

        return cls(
            api_base=req("KOBEAI_API_BASE").rstrip("/"),
            tap_box_id=req("KOBEAI_TAP_BOX_ID"),
            printer_id=req("KOBEAI_PRINTER_ID"),
            cups_printer=req("KOBEAI_CUPS_PRINTER"),
            secret=req("KOBEAI_TAP_BOX_SECRET"),
            nfc_path=os.environ.get("KOBEAI_NFC_PATH", "usb"),
            poll_interval_s=float(os.environ.get("KOBEAI_POLL_INTERVAL_S", "1.5")),
            request_timeout_s=float(os.environ.get("KOBEAI_HTTP_TIMEOUT_S", "10")),
        )


log = logging.getLogger("kobeai.tap-box")


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

class ApiClient:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.session = requests.Session()
        self.session.headers["x-tap-box-secret"] = cfg.secret

    def _url(self, path: str) -> str:
        return f"{self.cfg.api_base}{path}"

    def pair(self, watch_payload: dict) -> dict:
        r = self.session.post(
            self._url("/api/v1/print/pair"),
            json={
                "tap_box_id": self.cfg.tap_box_id,
                "printer_id": self.cfg.printer_id,
                "watch_payload": watch_payload,
            },
            timeout=self.cfg.request_timeout_s,
        )
        r.raise_for_status()
        return r.json()

    def next_job(self) -> Optional[dict]:
        r = self.session.get(
            self._url("/api/v1/print/next"),
            params={"printer_id": self.cfg.printer_id},
            timeout=self.cfg.request_timeout_s,
        )
        r.raise_for_status()
        return r.json().get("job")

    def download_document(self, job_id: str, dest_path: str) -> None:
        r = self.session.get(
            self._url(f"/api/v1/print/jobs/{job_id}/document"),
            stream=True,
            timeout=self.cfg.request_timeout_s,
        )
        r.raise_for_status()
        with open(dest_path, "wb") as fp:
            for chunk in r.iter_content(8192):
                fp.write(chunk)

    def report_status(self, job_id: str, status: str, message: str = "") -> None:
        try:
            self.session.post(
                self._url(f"/api/v1/print/jobs/{job_id}/status"),
                json={"status": status, "message": message},
                timeout=self.cfg.request_timeout_s,
            )
        except requests.RequestException as exc:
            log.warning("status report failed for job=%s: %s", job_id, exc)


# ---------------------------------------------------------------------------
# Print pipeline
# ---------------------------------------------------------------------------

def print_pdf(cups_printer: str, pdf_path: str) -> None:
    """Hand the PDF off to CUPS via `lp`. Blocks until accepted."""
    log.info("submitting %s to printer %s", pdf_path, cups_printer)
    subprocess.run(
        ["lp", "-d", cups_printer, pdf_path],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )


def handle_job(api: ApiClient, job: dict) -> None:
    import tempfile
    job_id = job["id"]
    log.info("picked up job %s (%s)", job_id, job.get("document_name"))
    # Use a private temp dir owned by the daemon so other users can't read
    # in-flight student documents.
    work_dir = "/var/lib/kobeai-tap-box/work"
    os.makedirs(work_dir, mode=0o700, exist_ok=True)
    fd, pdf_path = tempfile.mkstemp(suffix=".pdf", prefix=f"job-{job_id}-", dir=work_dir)
    os.close(fd)
    os.chmod(pdf_path, 0o600)
    api.report_status(job_id, "downloading", "Fetching document")
    try:
        api.download_document(job_id, pdf_path)
    except Exception as exc:  # pragma: no cover - network failures
        log.exception("download failed")
        api.report_status(job_id, "failed", f"download: {exc}")
        return

    api.report_status(job_id, "printing", "Sent to printer")
    try:
        print_pdf(api.cfg.cups_printer, pdf_path)
    except subprocess.CalledProcessError as exc:
        log.error("lp failed: %s", exc.stderr)
        api.report_status(job_id, "failed", f"lp: {exc.stderr.strip()[:120]}")
        return
    except Exception as exc:
        log.exception("print failed")
        api.report_status(job_id, "failed", f"print: {exc}")
        return

    api.report_status(job_id, "done", "Printed")
    log.info("job %s done", job_id)
    try:
        os.unlink(pdf_path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# NFC handling
# ---------------------------------------------------------------------------

# AID we registered for the KobeAI HCE service on the watch. Must match the
# `aid-filter` in the watch app's apduservice.xml.
KOBEAI_AID = bytes.fromhex("F00B0EA1F0")  # F0 + "KOBEAI" tag

def _select_apdu() -> bytes:
    """ISO-7816 SELECT AID command for the watch's HCE service."""
    return bytes([0x00, 0xA4, 0x04, 0x00, len(KOBEAI_AID)]) + KOBEAI_AID + bytes([0x00])


def parse_watch_payload(blob: bytes) -> dict:
    """Watch returns: student_id\\twatch_session_id\\tnonce\\tts_ms\\tsignature

    The ``ts_ms`` field was added so the server can reject NFC payloads
    captured and replayed minutes later. Older watch builds (4 fields) are
    rejected here rather than silently downgrading auth.
    """
    text = blob.decode("utf-8", errors="replace").strip()
    parts = text.split("\t")
    if len(parts) != 5:
        raise ValueError(f"unexpected payload (got {len(parts)} fields): {text!r}")
    try:
        ts_ms = int(parts[3])
    except ValueError as e:
        raise ValueError(f"invalid ts_ms in payload: {parts[3]!r}") from e
    return {
        "student_id": parts[0],
        "watch_session_id": parts[1],
        "nonce": parts[2],
        "ts_ms": ts_ms,
        "signature": parts[4],
    }


def nfc_reader_loop(api: ApiClient) -> None:  # pragma: no cover - requires hw
    if nfc is None:
        sys.exit("nfcpy not installed; run: pip install nfcpy")

    def on_connect(tag) -> bool:
        try:
            log.info("watch tapped: %s", tag)
            response = tag.transceive(_select_apdu())
            if not response or response[-2:] != b"\x90\x00":
                log.warning("watch did not return success status: %s", response.hex() if response else None)
                return True
            payload = parse_watch_payload(response[:-2])
            result = api.pair(payload)
            log.info("paired: %s", result.get("pairing_id"))
        except Exception:
            log.exception("tap handling failed")
        return True  # release the tag

    clf = nfc.ContactlessFrontend(api.cfg.nfc_path)
    log.info("NFC reader ready on %s", api.cfg.nfc_path)
    try:
        while True:
            clf.connect(rdwr={"on-connect": on_connect})
    finally:
        clf.close()


# ---------------------------------------------------------------------------
# Job polling loop (runs in a thread so it's independent of NFC)
# ---------------------------------------------------------------------------

def job_polling_loop(api: ApiClient) -> None:
    log.info("job poller started for printer=%s", api.cfg.printer_id)
    while True:
        try:
            job = api.next_job()
            if job:
                handle_job(api, job)
                continue  # check immediately for next
        except requests.RequestException as exc:
            log.warning("poll failed: %s", exc)
        time.sleep(api.cfg.poll_interval_s)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    cfg = Config.from_env()
    api = ApiClient(cfg)
    log.info("KobeAI tap-box %s -> printer %s", cfg.tap_box_id, cfg.printer_id)

    import threading
    poll = threading.Thread(target=job_polling_loop, args=(api,), daemon=True)
    poll.start()

    if "--simulate-tap" in sys.argv:
        # For local testing without an NFC reader. Reads a payload from stdin.
        log.info("simulate mode: paste a tab-separated payload and hit Enter")
        text = sys.stdin.readline().strip()
        api.pair(parse_watch_payload(text.encode("utf-8")))
        # then just keep the poller running
        poll.join()
    else:
        nfc_reader_loop(api)


if __name__ == "__main__":
    main()

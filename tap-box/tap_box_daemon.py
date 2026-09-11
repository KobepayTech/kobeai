#!/usr/bin/env python3
"""
KobeAI Print Agent (tap-box hardware)
=====================================

Runs on a Raspberry Pi sitting next to a school printer. It long-polls the
KobeAI API for print jobs that staff queued for this printer from the
Teacher Dashboard, downloads each PDF and pipes it to the local CUPS queue.

There is no NFC reader and no student pairing step: K9 has no student-worn
devices, so printing is always staff-initiated.

Hardware tested:
    Raspberry Pi Zero 2 W (any Pi 3+ also works)

Configuration is via environment variables — see /etc/default/kobeai-tap-box
in the installer. The file, service and variable names keep the historical
"tap-box" prefix so existing installs upgrade in place.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Optional

import requests

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
            poll_interval_s=float(os.environ.get("KOBEAI_POLL_INTERVAL_S", "1.5")),
            request_timeout_s=float(os.environ.get("KOBEAI_HTTP_TIMEOUT_S", "10")),
        )


log = logging.getLogger("kobeai.print-agent")


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

def print_pdf(cups_printer: str, pdf_path: str, copies: int) -> None:
    """Hand the PDF off to CUPS via `lp`. Blocks until accepted."""
    log.info("submitting %s x%d to printer %s", pdf_path, copies, cups_printer)
    subprocess.run(
        ["lp", "-d", cups_printer, "-n", str(copies), pdf_path],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )


def handle_job(api: ApiClient, job: dict) -> None:
    job_id = job["id"]
    copies = max(1, int(job.get("copies") or 1))
    log.info("picked up job %s (%s x%d)", job_id, job.get("document_name"), copies)
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
        print_pdf(api.cfg.cups_printer, pdf_path, copies)
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
# Job polling loop
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
    log.info("KobeAI print agent %s -> printer %s", cfg.tap_box_id, cfg.printer_id)
    job_polling_loop(api)


if __name__ == "__main__":
    main()

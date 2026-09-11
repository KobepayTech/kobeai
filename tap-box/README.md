# KobeAI Print Agent (tap-box)

A small Raspberry Pi appliance that sits next to each school printer. It
polls the KobeAI API for print jobs that staff queued for this printer,
downloads the PDF and prints it through CUPS.

Printing is always staff-initiated from the Teacher Dashboard — K9 has no
student-worn devices, so there is no NFC reader and no pairing step. The
folder, service and variable names keep the historical `tap-box` prefix so
existing installs upgrade in place.

## Bill of materials (per printer)

| Part                          | Approx. price | Notes                          |
|-------------------------------|---------------|--------------------------------|
| Raspberry Pi Zero 2 W         | $15           | Any Pi 3+ also works           |
| MicroSD card 16 GB            | $5            | Class 10 or better             |
| 5 V / 2.5 A power supply      | $5            | Pi-compatible                  |
| USB OTG cable                 | $2            | Pi Zero only                   |
| Small enclosure (3D printed)  | $5            | Optional                       |
| **Total**                     | **~$30**      |                                |

## Quick install on the Pi

1. Flash Raspberry Pi OS Lite (64-bit) to the SD card. Set up Wi-Fi and SSH.
2. Plug in the printer's USB cable.
3. Copy this folder to the Pi (e.g. `scp -r tap-box pi@tap-box-1:/tmp/`).
4. SSH in and run:

   ```bash
   sudo bash /tmp/tap-box/install.sh
   ```

   This installs Python deps, CUPS, the systemd unit, and a config file
   template. It does **not** start the service yet.

5. Add the printer to CUPS (one time):

   ```bash
   # discover what CUPS sees
   lpinfo -v

   # install the printer (replace the URI with what lpinfo found)
   sudo lpadmin -p Epson_L3250 -E -v usb://EPSON/L3250 -m everywhere
   sudo lpoptions -d Epson_L3250
   echo "test page" | lp -d Epson_L3250        # print a test page
   ```

6. Edit `/etc/default/kobeai-tap-box` with your real values:

   ```env
   KOBEAI_API_BASE=http://192.168.1.100:8000
   KOBEAI_TAP_BOX_ID=tap-lib-1
   KOBEAI_PRINTER_ID=printer-lib-01      # must exist in the API's PRINTERS map
   KOBEAI_CUPS_PRINTER=Epson_L3250       # the name from lpadmin above
   KOBEAI_TAP_BOX_SECRET=...             # must match TAP_BOX_SECRET on server
   ```

7. Start it:

   ```bash
   sudo systemctl start kobeai-tap-box
   journalctl -u kobeai-tap-box -f       # follow logs
   ```

## How a print job flows

1. A teacher opens **Documents** in the Teacher Dashboard, picks a document,
   a printer and a number of copies. The dashboard calls
   `POST /api/v1/print/jobs` with the teacher's JWT.
2. The API queues the job for that printer and writes a `print_jobs` audit
   row. If the job was sent for one student (`student_code`), it also shows
   in that child's parent print history.
3. The agent's poller picks the job up via `GET /api/v1/print/next`,
   downloads the PDF via `GET /api/v1/print/jobs/<id>/document`, pipes it to
   `lp -n <copies>`, and reports `done` (or `failed`) via
   `POST /api/v1/print/jobs/<id>/status`.

## Testing without the dashboard

Queue a job with a teacher token, then run the agent against a CUPS PDF
printer:

```bash
curl -X POST http://localhost:8000/api/v1/print/jobs \
  -H "Authorization: Bearer $TEACHER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"printer_id":"printer-lib-01","document_id":1,"copies":1}'

KOBEAI_API_BASE=http://localhost:8000 \
KOBEAI_TAP_BOX_ID=tap-test \
KOBEAI_PRINTER_ID=printer-lib-01 \
KOBEAI_CUPS_PRINTER=PDF \
KOBEAI_TAP_BOX_SECRET=dev-tap-box-secret \
python3 tap_box_daemon.py
```

## Security notes

- `KOBEAI_TAP_BOX_SECRET` authenticates the Pi → server channel. Generate a
  unique 32-byte secret per agent in production (`openssl rand -hex 32`)
  and store it server-side per `tap_box_id`.
- Only staff JWTs can queue jobs, and teachers can only print documents
  they uploaded (admins can print any document).

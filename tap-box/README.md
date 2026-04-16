# KobeAI Tap-Box

A small Raspberry Pi appliance that sits next to each school printer. It
reads NFC taps from student watches, asks the KobeAI API who tapped, then
pulls the queued document and prints it.

## Bill of materials (per printer)

| Part                          | Approx. price | Notes                          |
|-------------------------------|---------------|--------------------------------|
| Raspberry Pi Zero 2 W         | $15           | Any Pi 3+ also works           |
| MicroSD card 16 GB            | $5            | Class 10 or better             |
| ACR122U USB NFC reader        | $20           | Or PN532 board (~$8) over USB  |
| 5 V / 2.5 A power supply      | $5            | Pi-compatible                  |
| USB OTG cable                 | $2            | Pi Zero only                   |
| Small enclosure (3D printed)  | $5            | Optional                       |
| **Total**                     | **~$50**      |                                |

## Quick install on the Pi

1. Flash Raspberry Pi OS Lite (64-bit) to the SD card. Set up Wi-Fi and SSH.
2. Plug in the USB NFC reader and the printer's USB cable.
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
   journalctl -u kobeai-tap-box -f       # watch logs
   ```

## How a tap actually works end-to-end

1. Student walks up to the tap-box. Watch is locked or showing any screen.
2. Student taps watch on the NFC reader. The watch's HCE service receives
   an ISO-7816 SELECT command for AID `F00B0EA1F0`, replies with the
   payload `student_id<TAB>watch_session_id<TAB>nonce<TAB>HMAC-SHA256` and
   status `9000`.
3. The daemon reads that, hits `POST /api/v1/print/pair` on the API. API
   verifies the HMAC signature against `WATCH_HCE_SECRET`, creates a
   60-second pairing, returns it.
4. Watch app (which has been polling `/api/v1/print/pairing/<id>` every
   second since boot) sees the pairing appear and shows the file picker
   for that printer.
5. Student picks a doc on the watch. Watch calls `POST /api/v1/print/submit`.
6. The daemon's job poller picks the queued job up via `GET /next`,
   downloads the PDF via `GET /jobs/<id>/document`, pipes it to `lp`, and
   reports `done` (or `failed`).
7. Watch shows "Printed!" toast.

## Testing without an NFC reader

For dev / CI you can simulate a tap with the script's `--simulate-tap` flag:

```bash
KOBEAI_API_BASE=http://localhost:8000 \
KOBEAI_TAP_BOX_ID=tap-test \
KOBEAI_PRINTER_ID=printer-lib-01 \
KOBEAI_CUPS_PRINTER=PDF \
KOBEAI_TAP_BOX_SECRET=dev-tap-box-secret \
python3 tap_box_daemon.py --simulate-tap

# then paste a payload like:
#   TEST001<TAB>watch-session-abc<TAB><nonce><TAB><hmac-hex>
```

Generate a valid HMAC for testing:

```bash
SID=TEST001 WSESS=watch-session-abc NONCE=$(openssl rand -hex 8)
SIG=$(printf "%s|%s|%s" "$SID" "$WSESS" "$NONCE" \
      | openssl dgst -sha256 -hmac dev-watch-hce-secret | awk '{print $2}')
printf "%s\t%s\t%s\t%s\n" "$SID" "$WSESS" "$NONCE" "$SIG"
```

## Security notes

- `KOBEAI_TAP_BOX_SECRET` authenticates the Pi → server channel. Generate a
  unique 32-byte secret per tap-box in production (`openssl rand -hex 32`)
  and store it server-side per `tap_box_id`.
- `WATCH_HCE_SECRET` authenticates watch → server. The current
  implementation uses a single shared secret for all watches in a school
  (acceptable since the school owns and provisions every watch). For a
  multi-school SaaS, switch to per-watch keys enrolled at provisioning time.
- The `nonce` in the HCE payload is currently not replay-checked. Add a
  short-lived seen-nonce set on the server (Redis with `EX 120`) before
  going to production.

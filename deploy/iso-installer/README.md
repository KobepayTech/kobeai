# KobeAI Installer ISO

A bootable USB image that installs KobeAI on a fresh PC with **zero typing
during install**. One ISO, one boot menu, two roles:

```
╔══════════════════════════════════════╗
║      KOBE AI SCHOOL INSTALLER         ║
╠══════════════════════════════════════╣
║  1) Install KobeAI MASTER (laptop)   ║
║  2) Install KobeAI WORKER  (desktop) ║
║  3) Try Ubuntu Server (live)         ║
║  4) Boot from existing OS            ║
║  5) Recovery shell                    ║
╚══════════════════════════════════════╝
```

Pick a role, walk away for 20–30 minutes, and the box reboots into a fully
configured KobeAI node.

---

## What gets installed

### Master node (Lenovo laptop, default `192.168.1.10`)
- Ubuntu 24.04 LTS Server
- Docker + Docker Compose
- The KobeAI stack via `deploy/school-server/install.sh`:
  - PostgreSQL 16
  - Redis 7
  - Node API server (port 8000 internal)
  - Teacher dashboard (port 3000 internal)
  - Parent app (port 5173 internal)
- **Caddy 2** with a self-signed cert for `https://kobeai.school` and
  `https://192.168.1.10` (LAN-only, no internet certificate dependency)
- A ready-to-use `kobeai-admin` CLI on the path
- An auto-generated 16-character super-admin password, written to
  `/root/kobeai-credentials.txt` (root-only) and printed on the install screen
- UFW firewall: SSH + 80 + 443 open; everything else blocked

### Worker node (desktop, default `192.168.1.11`)
- Ubuntu 24.04 LTS Server
- Docker + Docker Compose
- Ollama listening on `0.0.0.0:11434`
- UFW firewall: only the master (`192.168.1.10`) can reach port 11434
- Phi 2.7B + Mistral 7B + nomic-embed-text models pulled on first boot
  (override with `KOBEAI_WORKER_MODELS=...` env if needed)

### Network plan (locked-in defaults)

| Node   | Hostname        | IP             | Gateway       |
|--------|-----------------|----------------|---------------|
| Master | `kobeai-master` | `192.168.1.10` | `192.168.1.1` |
| Worker | `kobeai-worker` | `192.168.1.11` | `192.168.1.1` |

If your school router uses a different subnet (e.g. `10.0.0.x`), edit the
`addresses:` and `routes.via:` lines in
`autoinstall/master/user-data` and `autoinstall/worker/user-data` before
building the ISO.

---

## Building the ISO

The ISO assembly itself **must run on a Linux machine** (Ubuntu / Debian)
or in WSL2 or a Linux VM. It needs ~10 GB free disk.

```bash
# 1. Install build tools (Ubuntu/Debian)
sudo apt update
sudo apt install -y xorriso p7zip-full curl rsync

# 2. From the repo root:
sudo bash deploy/iso-installer/build-iso.sh

# Output: deploy/iso-installer/out/kobeai-installer.iso
```

The script will:
1. Download the official Ubuntu 24.04.1 Server ISO (or use one you supply)
2. Extract it
3. Bake the entire KobeAI source tree into the ISO at `/payload/kobeai-src.tar.gz`
4. Inject the autoinstall profiles and the boot menu
5. Repack as a hybrid BIOS + UEFI bootable ISO

Total ISO size will be **~3.5–4 GB**. Fits on any 8 GB+ USB.

---

## Flashing the USB

**On Mac/Windows/Linux (recommended):** use [Balena Etcher](https://etcher.balena.io).

**Or on Linux directly** (replace `/dev/sdX` with your USB device — find it
with `lsblk` and triple-check, this wipes the device):

```bash
sudo dd if=deploy/iso-installer/out/kobeai-installer.iso \
        of=/dev/sdX bs=4M status=progress conv=fsync
sudo sync
```

---

## Installing on a school PC

1. Plug the USB into the target PC.
2. At the BIOS/firmware prompt (usually F12, F10, or Esc), pick the USB.
3. Pick **MASTER** for the Lenovo laptop, **WORKER** for the desktop.
4. Walk away. The PC will:
   - Wipe its disk
   - Install Ubuntu 24.04
   - Configure the static IP and hostname
   - Reboot
   - Run `kobeai-firstboot` (Docker install + KobeAI stack bring-up + model pulls)
   - Reach a "ready" state
5. SSH or sit at the console:
   ```bash
   sudo cat /root/kobeai-credentials.txt
   ```
   to get the super-admin password.

Total wall-clock time per machine: **20–30 min on a wired connection**, longer
on the worker because of the AI model downloads (~5 GB).

---

## Troubleshooting

**Watch the firstboot log live:**
```bash
sudo journalctl -u kobeai-firstboot -f
sudo tail -f /var/log/kobeai-firstboot.log
```

**Re-run firstboot from scratch** (e.g. after a network outage):
```bash
sudo rm /var/lib/kobeai/firstboot-done
sudo systemctl enable --now kobeai-firstboot.service
```

**Master can't reach worker:**
```bash
# from the master:
curl http://192.168.1.11:11434/api/version

# if it fails, on the worker:
sudo ufw status            # confirm 11434 is allowed from 192.168.1.10
docker ps | grep ollama    # confirm container is up
```

**Browser warning on `https://kobeai.school`:**
that's expected with the self-signed cert. Either:
- Click "Advanced → proceed" once per device, OR
- Import `/opt/kobeai/caddy/data/caddy/pki/authorities/local/root.crt` from
  the master into each staff laptop / phone as a trusted root.

---

## File map

```
deploy/iso-installer/
├── README.md                           ← this file
├── build-iso.sh                        ← run this on a Linux box
├── grub/grub.cfg                       ← boot menu shown when USB boots
├── autoinstall/
│   ├── master/{user-data,meta-data}    ← unattended Ubuntu install (master)
│   └── worker/{user-data,meta-data}    ← unattended Ubuntu install (worker)
└── payload/                            ← copied to /opt/kobeai-payload/ on the target
    ├── firstboot.sh                    ← orchestrates first-boot bring-up
    ├── kobeai-firstboot.service        ← systemd unit that runs firstboot.sh
    ├── master/
    │   ├── install-master.sh           ← runs deploy/school-server/install.sh + Caddy
    │   ├── Caddyfile                   ← LAN-only TLS for kobeai.school
    │   └── docker-compose.caddy.yml    ← overlay that swaps nginx for Caddy
    └── worker/
        ├── install-worker.sh           ← Docker + Ollama + model pulls
        └── docker-compose.yml          ← Ollama-only stack
```

---

## Day-2 operations (master node)

The ISO installs two operator tools onto the master, both runnable as `sudo`:

### `kobeai-update` — pull latest code and redeploy
```bash
sudo kobeai-update              # snapshot db → git pull → rebuild → up -d → migrate → health
sudo kobeai-update --no-build   # quick env-only redeploy
sudo kobeai-update --no-pull    # rebuild from current source (e.g. after manual edit)
```
Always takes a pre-update Postgres snapshot to `/opt/kobeai/backups/pre-update/`
so a bad release can be rolled back with one command (printed at the end).

### `kobeai-backup` — full snapshot to USB or local
Runs **nightly at 02:00 local time** automatically via `kobeai-backup.timer`.
Or run manually:
```bash
sudo kobeai-backup                     # auto-detect USB labelled KOBEAI-BACKUP
sudo kobeai-backup --dest /mnt/nas     # force a destination (NAS, external SSD, …)
sudo kobeai-backup --keep 30           # keep last 30 backups instead of 14
```
Each backup contains:
- `postgres.dump` (custom-format `pg_dump`, gzip-compressed)
- `redis.rdb`
- `config/.env`, `config/credentials.txt`, `caddy/` certs
- `MANIFEST.txt` with sha256 of every file

To make backups go to USB, format any USB stick (FAT32/exFAT/ext4 fine) with
the **label `KOBEAI-BACKUP`**, plug it into the master, and forget it. The
nightly job will mount it, write the backup, and unmount cleanly so the stick
can be physically rotated to off-site storage.

### Restore from a backup
```bash
# Postgres
docker exec -i kobeai-postgres pg_restore -U kobeai -d kobeai \
  --clean --if-exists < /mnt/kobeai-backup/kobeai-backups/kobeai-<timestamp>/postgres.dump

# Redis (stop, replace, start)
docker stop kobeai-redis
docker cp /mnt/.../redis.rdb kobeai-redis:/data/dump.rdb
docker start kobeai-redis
```

### Check the backup timer
```bash
systemctl status kobeai-backup.timer
systemctl list-timers kobeai-backup
journalctl -u kobeai-backup -n 100
```

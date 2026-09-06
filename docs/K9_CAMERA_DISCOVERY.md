# K-9 + KobeVision: self-discovering school camera network

KobeAI now embeds the full MIT-licensed `nyfeblade/K-9` repository as the `services/k9-network` Git submodule, pinned to a reviewed commit. K-9 is the network-discovery and camera-security layer; KobeVision remains the live video/face-analysis layer; KobeAI remains the timetable, attendance and school-workflow source of truth.

## Why this changes the product

Before K-9, camera installation was mostly manual: an installer had to know every camera/NVR IP address, decide which device was a camera, enter it into KobeAI, map it to a zone, and troubleshoot dead streams by hand.

With K-9 the school server can discover and inventory the CCTV network itself. That changes KobeAI from "AI attached to configured cameras" into a self-discovering campus camera platform.

```text
School LAN / CCTV VLAN
        |
        v
K-9 network awareness
  - host discovery (ARP / ping / TCP fallback)
  - vendor lookup
  - SSDP / mDNS / NetBIOS
  - camera + DVR/NVR fingerprinting
  - RTSP / ONVIF / admin-port detection
  - NEW / HIDDEN / EXPOSED / INSECURE / SURVEILLANCE flags
  - device history and health/security diagnostics
        |
        +---- local K-9 dashboard for authorised IT/security staff
        |
        v
KobeAI network inventory
        |
        v
Admin claims camera/NVR candidate
        |
        +---- assign logical camera ID
        +---- assign campus zone
        +---- add RTSP/ONVIF credentials locally (never stored in the central DB)
        |
        v
KobeVision live feed analysis
        |
        v
student sightings
        |
        v
KobeAI timetable-aware presence engine
```

## K-9 capabilities preserved

The whole K-9 codebase is retained as a submodule rather than reimplementing only camera discovery. This preserves its scan modes, local dashboard, device inventory, vendor intelligence, service fingerprinting, camera/NVR detection, quiet/hidden-device discovery, per-device annotations, trust state, first/last seen history, port history, network-change alerts, JSON export, security reports, TLS posture checks, known-CVE hints, UPnP internet-exposure checks, RTSP open-stream audit, anonymous-FTP audit, optional factory/weak-password audit, lockout/rate-limit checks, hardening checklists, authorised-scope controls, engagement log, SNMP/UDP/IoT checks, live activity checks and Linux Wi-Fi proximity locator.

Active/loud security actions remain manual and authorization-gated inside K-9. KobeAI's automatic sync uses only K-9 discovery/fingerprinting modes; it never launches credential tests automatically.

## New onboarding flow

### 1. Connect the school network

Existing IP cameras, household Wi-Fi cameras, DVRs and NVRs stay in place. Cameras only need to expose a usable local stream through RTSP/ONVIF/MJPEG directly or through the recorder.

The ideal topology is a dedicated CCTV VLAN/subnet reachable from the KobeAI school server.

### 2. K-9 scans the authorised CCTV network

The `k9-sync` service runs a machine-readable K-9 scan on a configurable interval (default five minutes) and posts the result into KobeAI.

KobeAI stores a normalized inventory containing IP, MAC, hostname, vendor, device type, K-9 category, flags, open ports, service banners, first/last seen state and whether the device is currently online.

### 3. Admin sees discovered devices instead of typing IPs

The admin camera setup should be driven from the discovery inventory:

```text
DISCOVERED CAMERA NETWORK

Hikvision DS-2CD...        10.20.0.21   CAMERA       Online
Dahua NVR...               10.20.0.10   SURVEILLANCE Online
TP-Link / Tapo...          10.20.0.31   CAMERA?      Online
Unknown device             10.20.0.44   NEW          Online
Physics camera             10.20.0.25   CAMERA       Offline
```

The admin selects a camera candidate and presses **Add to KobeAI**, chooses its school zone, and gives it a logical ID such as `physics-lab-front`.

### 4. Stream credentials are added locally

K-9 can identify that a device exposes RTSP/ONVIF and often recover model/vendor information, but credentials and exact stream profiles are deployment secrets.

The installer adds the RTSP/ONVIF credentials locally. They do not belong in the central KobeAI database. For an NVR, the installer can add each useful NVR channel as a logical KobeVision source even though K-9 sees one physical recorder.

### 5. KobeVision verifies the live stream

Before a camera becomes attendance evidence, KobeVision should verify:

- stream opens successfully;
- frame is recent rather than frozen;
- image quality is sufficient;
- face model is available;
- logical camera ID maps to an active campus zone.

A camera can be visible to K-9 but unusable for attendance, so network-online and vision-healthy are separate states.

## Revised operational state model

Every physical camera/recorder now has two health layers:

```text
NETWORK HEALTH (K-9)
  device reachable?
  IP/MAC/vendor known?
  RTSP/ONVIF/admin ports present?
  new/changed/exposed/insecure?

VISION HEALTH (KobeVision)
  stream opens?
  frames moving?
  image usable?
  face detector running?
  recent sightings arriving?
```

KobeAI should only treat a missing student as meaningful when the expected area has sufficient healthy camera coverage. If the relevant camera/NVR is offline, the result becomes `insufficient_camera_coverage`, not a student absence accusation.

## Revised attendance flow

```text
Every live sighting
        |
        v
student + camera + zone + time + confidence
        |
        v
rolling last-seen state

Every 30-minute checkpoint
        |
        v
1. Load current timetable period
2. Load class membership and subject overrides
3. Resolve each student's expected zone
4. Check expected-zone sightings
5. If missing there, search all recent campus sightings
6. Check camera coverage/health before deciding
7. Produce one state:

   on_schedule
   wrong_location
   not_seen
   low_confidence
   excused
   no_timetable
   configuration_missing
   insufficient_camera_coverage

8. Send only exceptions to staff review
```

## Example: Physics period

```text
10:00 Physics — Form 3A

Asha takes Physics
  expected: Physics Lab

Juma does not take Physics
  override: Library

K-9 network state:
  Physics camera: online
  Library camera: online
  Corridor cameras: online

KobeVision sightings:
  Asha -> Physics Lab 10:13, 94%
  Juma -> Library     10:11, 96%
  Musa -> Corridor B  10:17, 93%
  Neema -> no recent sighting

Checkpoint result:
  Asha  -> on_schedule
  Juma  -> on_schedule
  Musa  -> wrong_location (last seen Corridor B)
  Neema -> campus search; if healthy coverage and still unseen -> not_seen
```

If the Physics camera is down, KobeAI uses other sightings but does not interpret the absence of a Physics-Lab detection as proof that the student skipped class.

## Better use cases after adding K-9

### Zero-touch camera inventory

An installer no longer starts with a spreadsheet of camera IPs. KobeAI discovers likely cameras and recorders automatically and asks the installer to claim/map them.

### NVR-first deployments

Schools can retain existing NVR/DVR installations. K-9 finds the recorder and identifies its network/security state; KobeVision can consume channel streams from the NVR. This is the preferred path for existing schools.

### Household-camera deployments

Cheap household IP/Wi-Fi cameras can participate if they expose a local stream. K-9 helps identify them on the LAN and flags devices that only expose proprietary/cloud services or unsafe admin interfaces for installer review.

### Camera/network health becomes part of attendance quality

A camera outage can no longer silently create false attendance results. Network health, stream health and recognition confidence all influence whether KobeAI is allowed to flag a student.

### CCTV cybersecurity

Schools often deploy inexpensive cameras with weak defaults. K-9 adds a separate IT/security function: inventory new devices, track changed ports, detect cleartext/internet exposure, review firmware/CVE hints, produce security reports and run explicitly authorised audits.

### Rogue/new device detection

A new camera, recorder, unknown IoT device or unexpected admin service appearing on the school CCTV network becomes an admin/security alert independently of student attendance.

### Maintenance history

The school can answer questions such as:

- Which camera went offline before attendance quality dropped?
- When did a replacement NVR appear?
- Which camera changed IP or opened a new service?
- Which classrooms have weak/no camera coverage?

## User roles

### School installer / IT admin

Uses K-9 discovery, claims camera/NVR candidates, adds local stream credentials, assigns zones, verifies coverage, and handles device-security findings.

### School administrator

Sees camera-network health, new/flagged devices, attendance confidence, unresolved student exceptions and daily reports. Does not need to work with raw IP/port details unless authorised.

### Teacher

Sees class-period exceptions: wrong location, not recently seen, low-confidence identification, excused student, or camera-coverage problem. Teacher should not have access to K-9 credential/security audit tools.

### Parent

Sees attendance/arrival/departure summaries and school-confirmed exceptions, not continuous camera locations or network/security details.

## KobeAI network-discovery APIs

```text
POST /api/v1/network-discovery/k9/sync
GET  /api/v1/network-discovery/devices
GET  /api/v1/network-discovery/summary
POST /api/v1/network-discovery/devices/:deviceKey/claim-camera
POST /api/v1/network-discovery/devices/:deviceKey/trust
```

Useful query examples:

```text
GET /api/v1/network-discovery/devices?camera_only=true&online_only=true
```

## Deployment

Clone KobeAI with both KobeVoice and K-9:

```bash
git clone --recurse-submodules https://github.com/KobepayTech/kobeai.git
```

For an existing clone:

```bash
git pull
git submodule update --init --recursive
```

The school-server Compose stack starts:

- `k9`: full local K-9 dashboard, loopback-only by default;
- `k9-sync`: periodic K-9 inventory -> KobeAI sync;
- `vision`: live camera face analysis;
- `backend`: network inventory + timetable/presence decisions.

The resulting product is not simply facial attendance. It is a **self-discovering school camera, presence, timetable and CCTV-health platform** in which normal cameras/NVRs provide the video, K-9 understands and protects the camera network, KobeVision understands who is visible, and KobeAI understands whether that observation makes sense in the school timetable.

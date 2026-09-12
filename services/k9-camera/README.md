# K9 camera worker

Turns an IP camera or NVR channel into student sightings, using the models K9
already runs:

```text
camera (RTSP/HTTP)
   -> K9 model runtime /v1/faces        YuNet detection + SFace embeddings
   -> face gallery match                the students enrolled from the dashboard or the glasses
   -> POST /api/v1/presence/event       the timetable checkpoint engine takes it from there
```

Frames are processed in memory and never written to disk. Nothing here owns a
model path: faces come from the K9 runtime, and every model location lives in
`config/k9-models.json`.

## Why not KobeVision?

`services/kobevision` does the same job with InsightFace `antelopev2`, whose
weights K9 deliberately does not download for licensing reasons (see
`docs/VISION_ATTENDANCE.md`). This worker reuses that service's shape — a thread
per camera, sampled frames, per-student de-duplication, the same
`/v1/presence/event` contract — but recognises faces with YuNet + SFace, which
are installed and already proven by Teacher Lens. Either can feed the presence
engine; this one works today without a licensed model pack.

## Setup

1. **Enroll the students you want recognised.** Dashboard → Students → "Add
   photo", or from the glasses picker ("Remember this face"). Without enrolled
   faces the worker sees people but names nobody.

2. **Register a zone and the camera.** `/v1/presence/event` refuses an unknown
   `camera_id` with `camera_not_registered`:

   ```bash
   POST /api/v1/presence/zones    { "code": "CORRIDOR_A", "name": "Corridor A", "zone_type": "corridor" }
   POST /api/v1/presence/cameras  { "camera_id": "NVR_CH01", "name": "Corridor A", "zone_code": "CORRIDOR_A" }
   ```

   A classroom zone takes `class_id` so the timetable knows who belongs there.

3. **Write a local config file — outside this repository.** Copy
   `cameras.example.json` to somewhere like `C:\KobeOS\k9-cameras.json` and fill
   it in. **RTSP URLs contain camera passwords: never commit that file and never
   paste it into a chat or an issue.** The repo's `.gitignore` covers
   `k9-cameras*.json` so a stray copy here cannot be committed by accident.

   ```cmd
   set K9_CAMERAS_FILE=C:\KobeOS\k9-cameras.json
   set KOBEVISION_SHARED_SECRET=<the api-server's worker secret>
   set K9_RUNTIME_SECRET=<the runtime secret>
   ```

4. **Check the camera before running the loop:**

   ```cmd
   py services\k9-camera\camera_worker.py --check
   ```

   It opens each camera once and reports the frame size, how many faces it
   found, and who it recognised with what score. Then run it for real:

   ```cmd
   py services\k9-camera\camera_worker.py
   ```

## Camera URLs

| Source | Example |
|---|---|
| Phone RTSP app | `rtsp://<phone-ip>:8554/live` |
| Phone MJPEG app (IP Webcam) | `http://<phone-ip>:8080/video` |
| Hikvision sub-stream | `rtsp://user:pass@<ip>:554/Streaming/Channels/102` |
| Dahua sub-stream | `rtsp://user:pass@<ip>:554/cam/realmonitor?channel=1&subtype=1` |

Use the **sub-stream** (lower resolution) — recognition doesn't need 4K, and a
school PC analysing 1 frame per second per camera stays responsive. `sample_fps`
is per camera; 0.5–1.0 is plenty for presence.

The camera must be reachable from the machine running this worker. If the stream
won't open, test it in VLC first: the worker's reader is OpenCV with FFMPEG, so
anything VLC can play it can usually read.

## Confidence

SFace scores a match as a cosine and calls it the same person at **≥ 0.363**.
The presence checkpoint engine treats a sighting as confident at **≥ 0.86**
(`PRESENCE_MATCH_THRESHOLD`). Those are different scales, so the worker maps
cosine onto the engine's scale — the decision point lands just below "confident"
and a perfect match reaches 1.0 — and records the **raw cosine** in the event's
`metadata.sface_cosine`, so a reviewer sees the real evidence rather than only
the mapped number.

A sighting never becomes an absence or a punishment on its own: wrong-location
and low-confidence results are staff review flags.

## Tests

```cmd
py -m unittest discover -s services\k9-camera\tests
```

13 tests cover the confidence mapping, matching, the blurry-face skip, the
de-duplication window, several faces in one frame, and a refused event not
stopping the rest. The runtime and api-server are doubled, so no camera and no
server are needed.

## Privacy

- Only a student code, camera id, timestamp, confidence and face box leave this
  worker. No images.
- Enroll faces only with the consent your school's policy and local law require,
  and delete a student's enrolled faces when that consent ends
  (`DELETE /api/v1/faces/students/<code>`).
- Keep RTSP credentials in the local config file or the environment — never in
  the K9 database or the UI.

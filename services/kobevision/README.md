# KobeVision

KobeVision is KobeAI's on-premise face detection and recognition service for authorized school attendance deployments. It processes camera frames locally, stores encrypted face embeddings rather than enrollment photos, and posts identity sightings to the KobeAI presence API.

## Model profile

The default high-accuracy profile is `antelopev2`, which uses SCRFD-10G for face detection and a ResNet100/Glint360K recognition model through InsightFace. KobeAI does **not** download or bundle the model weights automatically. InsightFace's code is MIT licensed, but its public pretrained recognition model packs require separate commercial licensing for commercial deployment. Put a properly licensed model pack at:

```text
$VISION_MODEL_ROOT/models/$VISION_MODEL_PACK
```

Default container path:

```text
/state/insightface/models/antelopev2
```

You can replace the pack with another licensed InsightFace-compatible model without changing the attendance algorithm.

## Privacy boundary

- Raw camera frames are processed in memory and are not persisted by KobeVision.
- Enrollment photos are not written to disk.
- Face templates are normalized embeddings stored in an encrypted local file.
- `VISION_TEMPLATE_KEY` is required before enrollment/recognition templates can be persisted.
- Enrollment requires `consent_status=granted`.
- A face sighting only creates a presence event. Wrong-location and missing-student states are flags for staff review; they are not automatic disciplinary decisions.

## Required environment

```text
KOBEVISION_SHARED_SECRET=<same secret configured on KobeAI backend>
KOBEAI_BASE_URL=http://backend:8000
VISION_TEMPLATE_KEY=<Fernet key>
VISION_MODEL_PACK=antelopev2
VISION_MODEL_ROOT=/state/insightface
VISION_EXECUTION_PROVIDER=CUDAExecutionProvider
VISION_MATCH_THRESHOLD=0.60
VISION_DETECTION_THRESHOLD=0.60
```

Generate a Fernet key with:

```bash
python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

## Cameras

KobeVision can pull RTSP streams itself. Configure cameras with `VISION_CAMERAS_JSON`:

```json
[
  {"camera_id":"form2a-front","url":"rtsp://user:pass@10.0.0.21/stream1","sample_fps":1.0},
  {"camera_id":"library-main","url":"rtsp://user:pass@10.0.0.22/stream1","sample_fps":1.0}
]
```

The same `camera_id` must be registered in KobeAI through `/api/v1/presence/cameras` and mapped to a campus zone. RTSP credentials should live only in deployment secrets/environment configuration, never in the KobeAI database.

An NVR or edge device can instead push JPEG frames to `POST /v1/frame` with `camera_id`; the image is processed and discarded.

## Enrollment

`POST /v1/enroll` accepts multipart fields:

```text
student_code
consent_status=granted
image=<single clear face image>
```

Multiple enrollment angles can be submitted for the same student; KobeVision maintains a normalized centroid of up to five enrollment samples.

## Attendance flow

KobeVision itself does not decide whether a student is in the correct place. It emits sightings:

```text
camera -> face detection -> face embedding -> encrypted template match
       -> POST /api/v1/presence/event
```

The KobeAI backend then combines those sightings with the school timetable and subject overrides every 30 minutes. This separation keeps the vision model independent from school rules and makes it possible to change cameras/models without rewriting attendance logic.

# KobeAI Vision Attendance and Student Location

KobeAI now has a local computer-vision path for face-based attendance plus a timetable-aware location monitor.

## Architecture

```text
School cameras / NVR
        |
        v
KobeVision (local)
  SCRFD-10G face detection
  licensed high-accuracy face recognition model
  encrypted face-template matching
        |
        | recognized student sighting only
        v
POST /api/v1/presence/event
        |
        v
KobeAI presence database
        |
        +---- current timetable
        +---- class membership
        +---- student subject overrides
        +---- camera -> campus-zone map
        |
        v
30-minute checkpoint engine
        |
        +---- on schedule
        +---- wrong location -> staff flag
        +---- low confidence -> staff flag
        +---- not seen -> all-campus recent-camera search -> staff flag
```

Raw camera frames are not stored by KobeAI or KobeVision. KobeVision processes the image in memory and forwards a student code, camera ID, timestamp and confidence score.

## Face model

The default model profile is `antelopev2` through InsightFace: SCRFD-10G detection plus a ResNet100 recognition model trained on Glint360K. It is a strong local model profile for difficult angles and larger school deployments.

KobeAI deliberately does not auto-download model weights. InsightFace code is MIT licensed, while the public pretrained model packs are not licensed for ordinary commercial deployment without separate model rights. Production deployments should place a properly licensed compatible pack in the configured model directory.

The model adapter is replaceable. If KobeTech later licenses a higher-accuracy commercial model, the timetable/location engine does not need to change.

## Enrollment

KobeVision accepts enrollment only when `consent_status=granted`. It stores normalized embeddings in an encrypted local template file protected by `VISION_TEMPLATE_KEY`. It does not persist enrollment photographs.

For better recognition, enroll up to five clear angles per student. The service keeps a normalized centroid rather than retaining the photos.

## Campus zones

Register every area that matters to timetable rules, for example:

```text
FORM2A       classroom   room=Physics Lab / class_id=2
LIBRARY_MAIN library
DINING_HALL  dining
CORRIDOR_A   corridor
PLAYGROUND   outdoor
```

Then map each camera ID to exactly one zone. RTSP URLs and camera passwords stay in deployment configuration; only logical camera IDs and zone mappings are stored in KobeAI.

## Subject overrides

The timetable is class-level. A per-student override handles electives and exemptions.

Example:

```text
student_code: STU0042
subject: Physics
takes_subject: false
fallback_zone_type: library
```

During a Physics period the student is therefore expected in a library zone instead of the Physics classroom. If no override exists, KobeAI assumes the student follows the class timetable.

Lunch/breakfast/dinner/canteen subjects automatically expect a dining zone. Study/prep/library/free-period subjects automatically expect a library zone. Normal academic subjects expect a classroom zone matching the timetable room or class mapping.

## 30-minute checkpoint algorithm

The backend aligns checkpoints to `PRESENCE_CHECKPOINT_MINUTES`, which defaults to 30 minutes. For each active timetable period it:

1. Loads the students enrolled in that class.
2. Applies each student's subject override.
3. Resolves the expected zone from the timetable room/class or the fallback zone type.
4. Looks for a high-confidence sighting in the expected zone during the recent evidence window.
5. If the student is not found there, searches the student's recent sightings from **all registered campus cameras**.
6. Classifies the result as `on_schedule`, `wrong_location`, `not_seen`, `low_confidence`, or `configuration_missing`.
7. Saves the checkpoint result and exposes any uncertain/wrong result as a staff-review flag.

A missing or wrong-location result does not automatically trigger discipline or alter grades. Staff must confirm or dismiss the flag.

## Example behavior

```text
10:00 Physics period for Form 2A

Asha takes Physics
  expected -> Physics classroom
  seen in Physics classroom -> on_schedule
  seen in library -> wrong_location flag
  not found there -> search all cameras -> if found in dining, wrong_location flag
  nowhere on campus cameras -> not_seen flag

Juma does not take Physics
  subject override -> library
  seen in library -> on_schedule
  seen in Physics classroom -> wrong_location flag
  not in library -> search all campus cameras
```

## Main APIs

```text
POST /api/v1/presence/zones
GET  /api/v1/presence/zones
POST /api/v1/presence/cameras
GET  /api/v1/presence/cameras
POST /api/v1/presence/subject-override
POST /api/v1/presence/event
POST /api/v1/presence/checkpoint/run
GET  /api/v1/presence/checkpoints/latest
GET  /api/v1/presence/flags
POST /api/v1/presence/results/:id/review
GET  /api/v1/presence/student/:studentCode/current
GET  /api/v1/presence/health
```

`/presence/event` accepts the KobeVision service secret. Configuration and staff review endpoints require authenticated teacher/admin/super-admin access.

## Production safeguards

- Use cameras only inside the authorized school deployment boundary.
- Obtain and document the required student/guardian/school consent and local legal basis before biometric enrollment.
- Keep model thresholds conservative; false matches should become review flags, not automatic absences or punishment.
- Do not expose RTSP credentials through the application database or UI.
- Rotate `KOBEVISION_SHARED_SECRET` and `VISION_TEMPLATE_KEY` through deployment secret management.
- Delete a student's biometric template when enrollment/consent ends.
- Validate recognition accuracy across the school's real lighting, camera height, skin tones, uniforms, age groups and crowded scenes before using it operationally.

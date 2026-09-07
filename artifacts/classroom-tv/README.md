# classroom-tv

A minimal full-screen kiosk client for the KobeAI classroom TV. Runs in any
Chromium browser (or wrapped in an Electron/Chromium kiosk shell), pairs with
the school server via a shared secret at build time, and:

1. Shows the current lesson + upcoming schedule on the classroom TV.
2. Polls `GET /api/v1/classroom/celebrations/next` for approved-but-unplayed
   birthday celebrations and full-screens them for 30 seconds.

The kiosk never asks a teacher to log in — the school's IT operator bakes the
API base URL and shared secret into the build.

## Build

```
VITE_KOBEAI_API_BASE=https://your-school-server \
VITE_KOBEAI_KIOSK_SECRET=<matches CLASSROOM_KIOSK_SECRET on the api-server> \
VITE_KOBEAI_KIOSK_ID=form-3a-tv \
BASE_PATH=/ \
pnpm --filter @workspace/classroom-tv run build
```

Serve `dist/public/` from any static host and open the URL full-screen on the
classroom PC (`chromium --kiosk https://.../form-3a-tv` is a good default).

If the API base or the secret is missing at build time, the kiosk renders a
setup screen instead of silently 401'ing forever.

## What's here today, what's coming

The kiosk currently ships:

- A stub-timetable "Right now / Coming up" panel.
- The birthday celebration loop end-to-end (poll → full-screen overlay →
  server flips the row to `played`).

Follow-up work (server side already partially done):

- Real timetable via a new `GET /v1/classroom/context?kiosk_id=` route.
- Voice channel via KobeVoice (LiveKit) so the room can speak questions
  and see the AI's answer on the TV.
- Slot for the personalised magazine (already generated per student) to
  cycle school-wide highlights during transitions.

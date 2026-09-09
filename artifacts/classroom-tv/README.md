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

## Modes

The kiosk boots into one of three modes based on the URL:

- `?mode=display` (default) — classroom TV kiosk: current lesson + upcoming
  schedule, big-print, no chrome. Falls back to a stub view when no
  timetable is configured yet.
- `?mode=dashboard` — wall-mounted admin board: current period + live
  location-mismatches feed pulled from `/v1/classroom/live/mismatches`.
- `?mode=assistant` — teacher AI chat: text input → `POST /v1/classroom/ask`
  (server calls `askAI()`); rate-limited per kiosk id so one classroom
  can't exhaust the school's AI budget.

Birthday celebrations overlay every mode. The server's
`FOR UPDATE SKIP LOCKED` claim path means two kiosks never double-play.

## What's here today, what's coming

Shipped:

- All three modes above, wired to real server endpoints:
  - `/v1/classroom/context` — timetable + current period
  - `/v1/classroom/live/mismatches` — kiosk alias of `/v1/presence/live/mismatches`
  - `/v1/classroom/ask` — teacher AI question surface
  - `/v1/classroom/celebrations/next` — birthday celebration claim
- Setup screen when the build isn't paired.
- Bundle stays ~140 KB / 46 KB gz.

Follow-up:

- Voice channel via KobeVoice (LiveKit) so the assistant mode can accept
  spoken input from the room mic rather than typing on a wireless keyboard.
- Slot in display mode to cycle school-wide highlights from the
  personalised magazine during transitions.

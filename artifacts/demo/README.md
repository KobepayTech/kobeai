# @workspace/demo — KobeAI school demo

One command boots the whole K9 school AI stack against a local Postgres and
serves every persona from one Node process. Useful for evaluation, for
sales demos, and for local smoke testing of features that cut across the
api-server, presence engine, magazine, birthday flow, and classroom kiosk.

## Run it (dev mode)

```
# 1. Postgres. Skip if you already have one running with DATABASE_URL set.
docker compose -f artifacts/demo/docker-compose.yml up -d

# 2. Point the workspace at it.
export DATABASE_URL=postgres://postgres:demo@127.0.0.1:5433/postgres

# 3. Push the schema, build every UI once, then start the demo.
pnpm --filter @workspace/db run push
pnpm -r --filter "./artifacts/teacher-dashboard" \
       --filter "./artifacts/parent-app" \
       --filter "./artifacts/developer-portal" \
       --filter "./artifacts/classroom-tv" \
  run build

pnpm --filter @workspace/demo run start
```

Open <http://127.0.0.1:5555>. The landing page has links + demo credentials
for every persona.

Every ~8 seconds the world simulator:

- fires a bunch of presence events (mostly on-schedule, one persistent
  "Juma is in the library instead of Physics" mismatch, and a
  low-confidence corridor sighting)
- once every 4 ticks, drops a classroom-mic insight (question or
  misunderstanding)
- once every 10 ticks, auto-approves the demo birthday celebration so the
  classroom TV can full-screen it on the next poll

## Ship it as a single-file exe

The pack-exe script wraps the demo into a Node 22 Single Executable
Application. **Cross-compilation isn't supported** — run this on the target
OS.

```
pnpm --filter @workspace/demo run pack-exe
# → artifacts/demo/dist/kobeai-demo         (Linux / macOS)
# → artifacts/demo/dist/kobeai-demo.exe     (Windows, run from Git Bash)
```

The exe still needs `DATABASE_URL` at runtime, so the field kit is:

- `kobeai-demo` (or `kobeai-demo.exe`) — the single-file binary
- `docker-compose.yml` — one-command Postgres
- README with the two commands to run

## What's inside the demo world

- **Two classes**: Form 3A (Asha, Juma, Neema, Fatuma, Brian, Tumaini,
  Aisha) and Form 1A (John).
- **A full today's timetable** for Form 3A (Assembly / Biology / Maths /
  Physics / Lunch / Kiswahili / Geography) plus two Form 1A periods.
- **Eight campus zones + cameras** covering both classrooms, the physics
  lab, library, dining hall, main hall, front gate, and main corridor.
- **A birthday student** (`K9-BDAY`, Aisha Ndayishimiye) with their
  birthday set to today so the celebration flow lights up.
- **Quiz history + achievements + attendance rate** on Asha's learning
  profile so the magazine and profile pages have something to render.
- **A demo parent** (Grace Mwangi, `+255700000001` / `1234`) linked to
  Asha + Aisha so `parent-app` shows a school-day summary + magazine.
- **A running mismatch**: Juma keeps appearing in the library during
  Physics, so the live tile, dashboard mode, and vision-queue all
  visibly react.

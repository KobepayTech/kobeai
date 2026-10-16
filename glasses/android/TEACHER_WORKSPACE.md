> Current phone companion: **MoYoung / DA ECHO**. See [Android setup](ANDROID_STUDIO.md) and `MOYOUNG.md`. Earlier Rokid/HeyCyan details below describe historical integrations.

# Rokid teacher workspace

Rokid is the preferred device for the teacher companion app. On Android, Lens
preselects Rokid when the native host advertises it; first pairing requires an
explicit Connect action and the Rokid developer secret/device licence. Subsequent
sessions reuse encrypted provisioning and reconnect automatically. The web
version offers the phone camera and explains where to connect Rokid.

## Teacher features

- Today: current/upcoming **school-wide** timetable, and shortcuts to student
  lookup or paper review. The timetable API does not filter teacher assignments.
- Students: server-side name/code search (50 matches), learning strengths and
  support needs, recent papers, curated learning notes, and explicit teacher
  observations saved through the existing student-development API.
- Ask Kobe: subject-aware questions sent to the existing school AI endpoint;
  display its provider/model so a fallback is not represented as a live model.
  Responses can be spoken and sent to the connected display.
- Activity: the capture queue. Every photo is written to the phone
  (IndexedDB) before it is uploaded and stays there until the school server
  accepts it, across outages and app restarts. Photos are listed as pending,
  failed or completed, with Try now / Retry / Remove; nothing unsent is deleted
  without the teacher pressing Remove. The queue holds 240 unsent photos (or
  160 MB) per account; when full, capture stops and says so. The last 40
  completed captures stay listed, with an explicit server status refresh, and
  a completed capture is still not a submitted grade.
- Each capture has an id, sent as `x-lens-capture-id` on every attempt. The
  server ingests a capture exactly once: an advisory lock is held for as long
  as an attempt is ingesting it (a concurrent retry gets 409 however long that
  takes), and the vision request is committed together with the record of
  which capture produced it. A retry after success gets the first result; a
  server that dies mid-ingest leaves nothing behind
  (`api-server/src/lib/lens-capture.ts`, tested against the real route and
  PostgreSQL in `routes/teacher-lens.frame.test.ts`).
- A replayed frame keeps its context: the exam it was captured for travels
  with it, and `x-lens-capture-age-ms` lets the server record when the photo
  was taken (`captured_at`, and `graded_at` on the paper) on its own clock.
- A lookup more than two minutes old is refused by the server (410) and held
  back by the phone; it is never whispered late. It can be removed, not
  retried. Marking frames do not expire.
- Papers to review: a paper K9 has read is not a result. Activity lists each
  reading; Review shows the photograph, the marks K9 read and the name or code
  it read on the paper. That reading is displayed, never applied: the teacher
  picks the student from the exam's class, ticks that they have checked the
  paper, and saves. The server records one result per reading (a second save
  answers `duplicate`), keeps K9's reading (`metadata.review.ai`,
  `teacher_lens_reviews.ai_reading`) apart from who confirmed which student,
  and stores K9's proposed mark beside the teacher's on each question. A
  photograph can also be set aside without recording anything.
- Queued photos belong to the school server and teacher that captured them and
  are only uploaded under that same sign-in. Another teacher on the same phone
  sees a count, not the photos.
- The camera is the one selected in Connections. Glasses that are selected but
  not connected, or that fail to return a photo, produce an error; the phone
  camera is used only when "Phone camera" is chosen (always, on the web).
- Phone camera is off while the workspace is open. Hardware pairing stays alive;
  no background capture or new microphone streaming is introduced.

All requests use the existing teacher bearer token and school API. There is no
new database, AI provider, fee policy, or subscription bypass. Learning-note 403s
are surfaced, including when Claude's entitlement changes are present. Requests
have bounded timeouts and are aborted when leaving the workspace. No fake
student counts or dashboard fixture endpoints are used.

## Coordination with Claude

Inspected `claude/ai-question-market-onboarding-xxq2v3` at
`29867f568d9da9292bb72d517a13657a22c4130d`. Claude owns onboarding, subscription,
fees, student skills and associated backend changes. This work adds the teacher
workspace in separate UI files and reuses existing backend contracts.

A disposable integration worktree combined this branch with Claude's branch.
There were two conflicts, both resolved with this branch's versions:

- `artifacts/teacher-lens/src/App.tsx`: includes the shared camera import, native
  glasses bridge, workspace, and sign-out cleanup.
- `artifacts/teacher-lens/src/camera.ts`: keeps the shared hook introduced by
  Claude, with an optional `enabled = true` parameter and late-stream cleanup.
  Claude's onboarding calls `useCamera()` and retains its default behavior.

All other Claude files merged automatically. In particular, keep Claude's
`main.tsx`, `Onboarding.tsx` and onboarding styles. The combined Teacher Lens
passed TypeScript checking and a production Vite build. No unmerged backend
feature has been silently added to this PR or main. If Claude's branch advances,
repeat the integration check; these resolutions apply to the commit above.

No physical Rokid device or live school server was available for this work.

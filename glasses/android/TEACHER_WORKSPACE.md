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
- Activity: last 20 accepted capture request IDs in this sign-in, with an explicit
  server status refresh. This is memory-only, cleared on reload/sign-out, and
  does not claim an OCR completion is a submitted grade.
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

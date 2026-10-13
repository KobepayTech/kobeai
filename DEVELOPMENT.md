# KobeAI K9 Android

K9 is the teacher phone companion for KobeAI. Package: tz.kobe.k9.

## Product direction recovered from prior planning
- School server + Android phone + compatible teacher camera glasses.
- Local-first school processing; no OpenAI or Anthropic API key in the app.
- Current hardware focus: HeyCyan-compatible glasses, subject to verified SDK capabilities.
- Exam Mode photographs papers while the teacher marks normally, without reading aloud.
- Preserve teacher marks; separate confidence for identity, extracted answers, and marks.
- Review uncertain evidence before saving official results.
- Future upload queue must survive outages and prevent duplicate processing.
- Never substitute phone-camera capture for a missing glasses implementation.

## Current implementation
- Compose teacher home screen and selectable task modes.
- Validated school server address saved locally.
- Explicit unavailable states for server sign-in, glasses, and sessions.
- No network calls, hardware integration, evidence storage, or official result writes yet.

## Existing source inspected
Local reference: C:/Users/HomePC/AndroidStudioProjects/kobeai/glasses/src/k9/K9Api.ts
Repository discussed previously: KobepayTech/kobeai.
Local copies have a TypeScript glasses layer but no glasses/android directory.
Their freshness relative to remote branches has not been verified.

Existing TypeScript contract uses /api/v1/teacher-lens/session, /frame,
/frame/{requestId}, /whisper/next, and /lookup, with teacher bearer authentication.
Validate against current backend routes before implementing Android networking.

## Next integration work
1. Inspect current repository branches for native Android / HeyCyan SDK bindings.
2. Verify server authentication contract and add sign-in and connectivity.
3. Integrate real glasses capabilities with development-only proprietary SDK guards.
4. Add durable image queue and teacher review, then enable sessions.

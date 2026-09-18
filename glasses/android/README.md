# KobeAI Lens native glasses connection

This Android shell bundles the existing Teacher Lens app and connects its camera
source to the native SDKs. Existing login, per-teacher sessions, face lookup,
paper reading and human-reviewed marking stay on the school's KobeAI server.
No alternate database or AI cloud is introduced.

## Hardware paths

| Build | Install on | SDK binding | Exposed today |
|---|---|---|---|
| `companion` / Rokid | Teacher's Android phone (Android 10+) | xg.glass `RokidGlassesClient` → Rokid CXR-M | JPEG capture, text display, vendor TTS |
| `companion` / HeyCyan | Teacher's Android phone (Android 10+) | Vendor `glasses_sdk_20250723_v01.aar`, `BleOperateManager`, `LargeDataHandler` | BLE connection + fresh AI-preview JPEG capture; phone TTS follows OS audio routing |
| `rayneo` | RayNeo X2 itself | xg.glass `RayNeoRuntimeGlassesClient` (Camera2 on glasses) | JPEG capture, runtime text display; speech uses Android TTS if installed |

These are implemented bindings, **not a hardware certification**. RayNeo X3 Pro
is untested upstream. RayNeo Air display-only models cannot use this runtime.
Never install the RayNeo variant on a phone and mistake the phone camera for
connected RayNeo hardware. This uses the xg.glass Android runtime, not the Unity
OpenXR ARDK: Lens does not need a Unity scene or stereoscopic 3D renderer.

Live glasses microphone input, continuous video, image display and sensor streams
are deliberately not exposed in this bridge. The existing browser wake-word
feature is separate and is not guaranteed inside Android WebView. Use the Lens
shutter. HeyCyan preview images may be insufficient for small exam handwriting;
use the phone camera until a sample confirms legibility. No direct full-resolution
Wi-Fi album download or vendor assistant replacement is claimed.

## Build

Requirements: JDK 17, Android SDK platform 36, pnpm 9.15.9, network access to
Google/Maven Central/Rokid Maven/Gradle, and a vendor licence for SDK distribution.

From the repository root:

```sh
corepack pnpm@9.15.9 --filter @workspace/glasses --filter @workspace/teacher-lens --filter @workspace/scripts install --frozen-lockfile
corepack pnpm@9.15.9 --filter @workspace/teacher-lens build
python3 glasses/scripts/fetch_heycyan.py
cd glasses/android
./gradlew :app:assembleCompanionDebug :app:assembleRayneoDebug
```

Set `ANDROID_HOME` or an untracked `local.properties` with `sdk.dir` first.
The AAR fetch pins commit `f76a8bf40928d96387d1cc28984e7a29a9cd7ad1` and verifies
SHA-256. It is ignored by git, remains unmodified and is proprietary. Confirm the
vendor's commercial terms before distributing the companion APK. The RayNeo build
does not require the HeyCyan AAR. SDK build artifacts use xg.glass Maven 0.3.0.

`Glasses Android` CI compiles both variants without publishing APKs. The checked-in
Gradle wrapper is from xg.glass commit `c697e7faadde27762c9aa3954f6ed7e65961c28f`.

## Connect to KobeAI

1. Serve the school's API over **HTTPS** with a certificate trusted by Android.
   It may be a school-LAN server; an internet AI service is not required.
   The production app does not send teacher credentials over HTTP or bypass TLS.
2. Append `https://appassets.androidplatform.net` to the API server's existing
   `CORS_ALLOWED_ORIGINS` list and restart the server. Keep existing origins.
3. Install the appropriate APK and enter the school server URL and teacher login
   in Lens. The bearer token stays in the existing app's local storage, not in
   the glasses firmware. Android backup is disabled for this app.
4. Choose the glasses type and tap **Connect**. Grant the requested permissions.
   - Rokid: enter the developer client secret and select the device-SN `.lc`
     licence downloaded from the Rokid developer console. Both remain in memory.
   - HeyCyan: choose the device from the native BLE scan. Disconnect the HeyCyan
     app first if it holds the connection. Pair its audio output in Android's
     Bluetooth settings to hear phone speech through the glasses.
   - RayNeo: run the RayNeo build on the glasses and allow Camera access.
5. Choose **Lookup** or **Mark paper**, then tap the shutter. A real JPEG is
   required before upload. Results use the existing session and whisper queue.
   Review extracted marks before submission, as in the existing Lens workflow.
6. Select **Phone camera → Connect** to return to the phone. A dropped glasses
   connection refuses capture until reconnect; it does not silently take a
   picture from the phone.

## Validation record and remaining gates

Local validation: 16 SDK tests passed; SDK + Teacher Lens TypeScript checks passed;
Teacher Lens production web build passed. Android assembly was attempted but the
local environment could not download Gradle (`Network is unreachable`). Check the
PR's native CI result before installing. No physical glasses were available.

For each sample record model, firmware, Android version and SDK licence:

- Pair, deny permissions, cancel setup, reconnect after Bluetooth loss.
- Capture two different scenes and verify new JPEG bytes reach the correct K9
  session, including the chosen exam ID for marking.
- Confirm unreadable images remain reviewable and no grades are auto-submitted.
- Verify whispers are audible through the intended device; confirm display text
  on Rokid/RayNeo. RayNeo may need a separately installed Android TTS engine.
- Cancel a pending capture; sign out; relaunch; check no old session gets frames.
- Reject expired teacher tokens, untrusted TLS and disallowed CORS origins.
- Verify an external URL/iframe cannot call the native hardware bridge.

## Sources

- https://github.com/hkust-spark/xg-glass-sdk — Android SDK, Apache-2.0; vendor
  dependencies carry their own licences.
- https://github.com/ebowwa/HeyCyanSmartGlassesSDK — proprietary vendor SDK mirror,
  development guide and sample. A generic W610 label does not prove compatibility.
- https://ar.rokid.com/sprite?lang=en — Rokid developer authorization.

The bridge is only exposed to the bundled asset origin's main frame. It does not
open a LAN port or attach native APIs to a remotely hosted page. Device actions
are bounded, serialized, and return errors; images are resized to at most 1600px
before crossing into JavaScript.

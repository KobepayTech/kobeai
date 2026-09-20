# KobeAI Lens native glasses connection

This Android shell bundles the existing Teacher Lens app and connects its camera
source to the native SDKs. Existing login, per-teacher sessions, face lookup,
paper reading and human-reviewed marking stay on the school's KobeAI server.
No alternate database or AI cloud is introduced.

## Hardware paths

| Build               | Install on                            | SDK binding                                                | Exposed today                                                            |
| ------------------- | ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `companion` / Rokid | Teacher's Android phone (Android 10+) | xg.glass `RokidGlassesClient` → Rokid CXR-M                | JPEG capture, text display, vendor TTS                                   |
| `rayneo`            | RayNeo X2 itself                      | xg.glass `RayNeoRuntimeGlassesClient` (Camera2 on glasses) | JPEG capture, runtime text display; speech uses Android TTS if installed |

These are implemented bindings, **not a hardware certification**. RayNeo X3 Pro
is untested upstream. RayNeo Air display-only models cannot use this runtime.
Never install the RayNeo variant on a phone and mistake the phone camera for
connected RayNeo hardware. This uses the xg.glass Android runtime, not the Unity
OpenXR ARDK: Lens does not need a Unity scene or stereoscopic 3D renderer.

Live glasses microphone input, continuous video, image display and sensor streams
are deliberately not exposed in this bridge. The existing browser wake-word
feature is separate and is not guaranteed inside Android WebView. Use the Lens
shutter. No direct full-resolution Wi-Fi album download or vendor assistant
replacement is claimed.

### Why HeyCyan was removed

The companion build previously also bound a HeyCyan-compatible BLE device
through a proprietary vendor AAR. It was dropped, because the trade was a bad
one in all three directions:

- **It could not do the main job.** Its capture path was
  `LargeDataHandler.getPictureThumbnails` — a thumbnail over BLE. This file used
  to warn that those previews "may be insufficient for small exam handwriting".
  Reading a marked script is the product; Rokid captures 2400×1800 at q90 over
  Wi-Fi P2P.
- **It was half a device.** `display()` and `speak()` both raised, so it
  advertised `{"camera": true}` and nothing else. The teacher whisper — the name,
  the weak skill, what to ask next, on the lens — needs a display.
- **There was no licence to ship it under.** The AAR came from a third-party
  republication whose own README says "This SDK is proprietary software. Contact
  HeyCyan for licensing information." Because `companion` is one flavour, that
  binary rode along in every Rokid build too, guarded only by a comment.

Rokid, by contrast, is an Apache-2.0 wrapper over a vendor SDK with a per-device
`.lc` licence obtained from Rokid's own developer console — a relationship that
can actually be entered.

## Build

Requirements: JDK 17, Android SDK platform 36, pnpm 9.15.9, and network access to
Google/Maven Central/Rokid Maven/Gradle.

From the repository root:

```sh
corepack pnpm@9.15.9 --filter @workspace/glasses --filter @workspace/teacher-lens --filter @workspace/scripts install --frozen-lockfile
corepack pnpm@9.15.9 --filter @workspace/teacher-lens build
cd glasses/android
./gradlew :app:assembleCompanionDebug :app:assembleRayneoDebug
```

Set `ANDROID_HOME` or an untracked `local.properties` with `sdk.dir` first.
No proprietary binary is fetched or vendored: every SDK artifact resolves from
Maven Central at xg.glass 0.3.0. Distributing the companion APK still needs a
Rokid device licence, which is per device and comes from Rokid, not from us.

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
   From Android 12 these are nearby-device permissions only: `BLUETOOTH_SCAN` is
   declared `neverForLocation`, so no location permission is requested and the
   Precise/Approximate choice cannot block a pairing. Android 10–11, where a BLE
   scan genuinely requires it, still asks for location.
   - Rokid: enter the developer client secret and select the device-SN `.lc`
     licence downloaded from the Rokid developer console. After successful pairing, both are encrypted on this phone using Android Keystore.
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
- https://ar.rokid.com/sprite?lang=en — Rokid developer authorization.

The bridge is only exposed to the bundled asset origin's main frame. It does not
open a LAN port or attach native APIs to a remotely hosted page. Device actions
are bounded, serialized, and return errors; images are resized to at most 1600px
before crossing into JavaScript.

## Automatic connections

After first provisioning, Rokid reconnects at sign-in without prompting again.
Only successful provisioning is saved, encrypted with an Android Keystore AES-GCM
key. Forget pairing removes the stored credentials **and** the Rokid client's own
reconnect cache (`xgglass_rokid_bt_reconnect`: `socket_uuid`, `mac_address`),
which `ensureBluetoothConnected` dials before it will scan for anything else.
Clearing only ours left the phone still bound to the previous glasses. Choosing Phone camera pauses
automatic reconnection; explicitly connecting Rokid enables it again.

A connected-device foreground service keeps the current SDK session eligible
while the app is minimised. Android shows an ongoing connection notification with
a Pause action — which on Android 13+ requires `POST_NOTIFICATIONS`, asked for
alongside the Bluetooth permissions on a Rokid connect. It is asked as an
optional permission: refusing it costs the teacher the Pause action, not the
glasses, so a denial never fails the connection. Dropped Rokid connections retry at 3, 6, 12, 24, 48 then 60-second
intervals. Each attempt is bounded by the hardware's own connect budget
(`RokidOptions.connectTimeoutMs`, pinned at 30s) plus 20s of headroom: the SDK
wraps its whole handshake — cached-MAC reconnect, scan, init, BT socket, Wi-Fi
P2P — in that budget, so a watchdog sized at the same 30s fired first every time
and cancelled the handshake mid-scan. Photos and microphone recording are
not started in the background. Signing out cancels retries and disconnects.

First-time provisioning is interactive — a dialog for the developer client
secret, then Android's document picker for the `.lc` licence — so that one call
is given ten minutes rather than the 75 seconds every other bridge call gets.
The previous flat budget expired while the picker was still open and reported
the connection as failed. Unattended reconnects keep the short budget: nobody is
waiting on a dialog, and a wedged one should give up quickly.

The upstream Rokid client requires an Activity. Activity destruction, task
removal, force-stop or process death ends this session; reopening the app resumes
from encrypted provisioning. This is not a boot-time/headless persistent service.
Battery restrictions, range and revoked Bluetooth permissions still affect it.

The school URL and teacher session are reused. Authenticated server checks run
quietly while the interface is visible, with bounded retries and recovery on
network return/resume. These HTTPS requests do not need a permanent socket.
Expired/revoked teacher authorization requires sign-in; it is not retried forever.
The native Bluetooth service does not keep WebView polling or server AI processing
running after the UI has been destroyed.

Validation: browser protocol fixtures exercise automatic connection without a
button, pause (no further auto-connect), forgetting provisioning and sign-out.
Hardware checks must cover minimising, Bluetooth loss/return, notification Pause,
permission revocation, process death and reopening before production rollout.

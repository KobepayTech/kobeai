# MoYoung / DA ECHO migration

MoYoung is the active phone-companion provider. Rokid is removed from the build,
pairing UI, automatic-connection flag and credential flow. Old Rokid credentials
are not interpreted as MoYoung pairing data. Existing unrelated hardware adapters
remain available in the shared SDK; this companion advertises only `moyoung`.

## Implemented

- Explicit device selection from Android BLE scan results; remember only after connection.
- MoYoung CRPBleClient connection and battery callbacks.
- AI-recognition capture (TakePhoto mode 1), receiving a JPEG through
  CRPAiDialogueListener.onDialogueImageChange. The exact W620 firmware still needs
  hardware validation. This is not bulk Wi-Fi file sync or a video stream.
- Existing secure WebMessage host sends normalized JPEGs into Teacher Lens/K9.
- Existing automatic reconnect, Pause/Forget, foreground notification and phone TTS.
- No hard-coded glasses IP, DA ECHO app requirement or Rokid licence prompt.

Microphone streaming, glasses audio output, display, camera streaming and bulk
Wi-Fi downloads are NOT exposed. Android TTS uses the phone's selected system
output; Bluetooth media playback must be paired and tested separately.

## Build

Run `python3 glasses/scripts/fetch_moyoung.py` at repository root. The script pins
publisher package 1.3.8 and checks the downloaded archive against pub.dev's published SHA-256 metadata. The native core is now 1.0.0_20260928, and the download also includes lib-awlicense-1.0.1-release.aar. The script records each AAR's SHA-256 in a local manifest.
Run the Lens build, then `./gradlew :app:assembleCompanionDebug` in this directory.
SDK binaries remain ignored by git. CI compiles but does not publish an APK.
The core SDK references Jieli audio-decoder and OTA classes, so the pinned
publisher-supplied runtime libraries are included for class resolution. No firmware
update or payment feature is exposed. Their individual terms and source availability
must also be checked before APK distribution. Test runtime behavior on hardware.

## Licensing and provenance

Publisher: https://pub.dev/packages/moyoung_glasses_ble_plugin/versions/1.3.8
Example: https://github.com/liangqian609/moyoung_glasses_ble_plugin
Reference: https://github.com/FerSaiyan/Alternative-HeyCyan-App-and-SDK

The current 1.3.8 publisher page lists MIT for the Flutter plugin, whereas the
older bundled license record refers to GPL-3.0. This discrepancy must be
resolved before distribution. In particular, the native 1.0.0 AAR and
lib-awlicense may have separate proprietary/source and runtime authorization
requirements; a plugin-level MIT label does not automatically license all
binary dependencies. Obtain written permission and required notices/source
before distributing a combined APK. The release build remains blocked.
No compiled APK is publicly distributed by this change.

### 1.3.8 changes relevant to K9
- Android core updated from 0.0.7_20260624 to 1.0.0_20260928.
- 1.3.7 added Wi-Fi transport reset/self-healing and changed media download
  callbacks; 1.3.8 fixes partial/interrupted media import handling.
- K9 currently uses BLE AI-dialogue still-photo capture, not bulk media import.
  These upstream fixes do **not** prove better still-photo delivery or
  compatibility with our W620 firmware. Physical capture tests remain required.
- The newer SDK invokes a device authorization endpoint; fully offline
  first-time authorization is **not** guaranteed until tested.
- Our native bridge has not yet implemented the new bulk-media callback API,
  Wi-Fi recovery commands, or the new gateway service. SDK upgrade alone does
  not enable these features.

## Hardware acceptance gate

1. Clean install; reject permissions and cancel scan selection without crashes.
2. Select the actual MoYoung device (other BLE names are not proof of compatibility).
3. Connect, query battery, capture a page, verify the returned image is fresh.
4. Confirm K9 receives the page under the signed-in teacher and selected session.
5. Power glasses off during capture: fail visibly, reconnect, then capture afresh.
6. Pause, resume, forget, minimize, reopen and kill/restart the app.
7. Verify phone/earbud speech; do not claim glasses playback until observed.
8. Repeat on school WLAN without Internet. Record hardware, firmware and Android version.

No physical-device acceptance or native SDK source-completeness claim is made.

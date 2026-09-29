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
publisher package 1.3.6 and checks both archive and core AAR SHA-256 values.
Run the Lens build, then `./gradlew :app:assembleCompanionDebug` in this directory.
SDK binaries remain ignored by git. CI compiles but does not publish an APK.
The core SDK references Jieli audio-decoder and OTA classes, so the pinned
publisher-supplied runtime libraries are included for class resolution. No firmware
update or payment feature is exposed. Their individual terms and source availability
must also be checked before APK distribution. Test runtime behavior on hardware.

## Licensing and provenance

Publisher: https://pub.dev/packages/moyoung_glasses_ble_plugin/versions/1.3.6
Example: https://github.com/liangqian609/moyoung_glasses_ble_plugin
Reference: https://github.com/FerSaiyan/Alternative-HeyCyan-App-and-SDK

The published package declares GPL-3.0; the supplied license is preserved in
LICENSE-MOYOUNG-SDK. Our original Android companion changes may be distributed
under GPL-3.0; compatible third-party code retains its notices. This does not
relicense independent server code. Before distributing a combined APK, provide
its complete corresponding source (including the vendor SDK source and build
materials), required notices and any other applicable GPL installation information.
The AAR alone and the Flutter example repository do not establish availability of
all corresponding native SDK source. Obtain it from MoYoung or obtain a suitable
alternative license. No compiled APK is being publicly distributed by this change.

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

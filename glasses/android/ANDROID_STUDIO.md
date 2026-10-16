# K9 Android Studio setup — MoYoung / DA ECHO

Open `glasses/android` as the Gradle project. Run web build commands from the repository root.

```sh
pnpm install --frozen-lockfile
python3 glasses/scripts/fetch_moyoung.py
pnpm --filter @workspace/teacher-lens build
pnpm --filter @workspace/student-tablet build
cd glasses/android
./gradlew :app:assembleCompanionDebug
```

Select `companionDebug` for the teacher phone. `rayneo` is an independent on-glasses variant; it is not the MoYoung phone application. Android Studio manages `local.properties` for your SDK installation.

The project pins AGP 9.2.1, Gradle 9.6.1, Kotlin 2.4.0 and Android SDK 36. The phone minimum is Android 10. Use a compatible Android Studio and JDK 17 or newer.

## Pairing and testing

1. Open K9, sign in to the school server, then open Settings → connections.
2. Turn on the glasses and Bluetooth. Select MoYoung, connect, grant Nearby devices, and select the actual glasses from the scan list.
3. Wait for Connected. Run Test capture speed and verify each photograph is fresh and legible.
4. Select an exam, start marking and check the photo queue and paper review on the school server.
5. Test disconnection during a capture, reconnect, notification Pause, Forget pairing and app restart.
6. Explicitly select Phone camera to use it. A glasses failure must never silently use the phone camera.

Successful pairing is remembered. The SDK session is Activity-owned; process death requires reopening the app. Physical device compatibility and capture speed remain unverified until tested with the exact model and firmware.

The native provider is `app/src/companion/java/tz/kobe/glasses/MoYoungHardware.kt`; Bluetooth selection is in `ProviderFactory.kt`, saved pairing in `MoYoungPairing.kt`, and the origin-restricted web bridge in `MainActivity.kt`.

SDK package 1.3.6 and native AAR 0.0.7 are deliberately pinned to the existing integration. This does not use newer SDK 1.0.0 APIs or its activation flow. See `MOYOUNG.md` for provenance, capability limits and distribution gates. Release APK packaging remains blocked pending vendor redistribution/source clearance.

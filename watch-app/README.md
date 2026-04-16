# KobeAI Watch App (Wear OS)

The Kotlin / Jetpack Compose for Wear OS client for KobeAI. Talks to the same
backend that powers the Teacher Dashboard and Parent App.

> This app cannot be built or run inside Replit (the Replit project is
> Node/TypeScript). Open this folder in **Android Studio** on your laptop to
> compile and install the APK on a Wear OS watch or emulator.

## What's inside

```
watch-app/
├── app/
│   ├── src/main/
│   │   ├── AndroidManifest.xml
│   │   ├── res/                       icons, strings, device-admin policies
│   │   └── java/com/kobeai/watch/
│   │       ├── KobeAIApplication.kt   Hilt entry point
│   │       ├── MainActivity.kt        Compose nav host + kiosk mode
│   │       ├── admin/                 Device-admin receiver
│   │       ├── receivers/             Boot receiver
│   │       ├── services/              Foreground sync service
│   │       ├── workers/               WorkManager offline-sync worker
│   │       ├── data/
│   │       │   ├── PreferencesManager.kt    DataStore (token, balance, URL)
│   │       │   ├── OfflineDataManager.kt    Offline queue + canned answers
│   │       │   └── remote/                  Retrofit ApiService + NetworkModule
│   │       └── presentation/
│   │           ├── theme/             Colors, typography, MaterialTheme
│   │           └── screens/           Login / Home / Chat / Quizzes / Quiz /
│   │                                  Wallet / Attendance
│   └── build.gradle.kts
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
└── proguard-rules.pro
```

## How it connects to KobeAI backend

The watch hits a stable `/api/v1/watch/...` URL prefix. The Replit-hosted API
server (in `artifacts/api-server`) ships a compatibility router
(`watch-compat.ts`) that exposes those routes. Endpoints used by the watch:

| Watch path | Purpose |
|---|---|
| `POST /api/v1/watch/login` | Student login (`student_id` + `pin` + `device_id`) |
| `POST /api/v1/watch/ask` | Ask the AI tutor a question (deducts from balance) |
| `GET  /api/v1/watch/quizzes` | List available quizzes |
| `GET  /api/v1/watch/quiz/{quizId}/start` | Start a quiz attempt |
| `POST /api/v1/watch/quiz/{quizId}/submit` | Submit answers, get score |
| `POST /api/v1/watch/attendance/checkin` | Daily check-in (+20 KP) |
| `GET  /api/v1/watch/wallet` | Wallet balance + recent transactions |
| `POST /api/v1/watch/sync` | Drain offline queue |
| `POST /api/v1/watch/heartbeat` | Device heartbeat (battery, etc.) |

Demo credentials: `student_id=TEST001`, `pin=1234`.

## Pointing the watch at your deployed API

The base URL is set as a `BuildConfig` constant. There are three ways to
configure it:

1. **At build time** — pass a Gradle property:
   ```bash
   ./gradlew assembleRelease -PKOBEAI_API_BASE=https://your-app.replit.app/
   ```
   (Trailing slash is required.)

2. **From inside the watch app at runtime** — call
   `prefsManager.setServerUrl("https://your-app.replit.app/")` from a debug
   shortcut. The value is persisted in DataStore and overrides BuildConfig.

3. **Edit the default** — change `KOBEAI_API_BASE` in `app/build.gradle.kts`.

Once your API server is published, copy the deployment URL and rebuild.

## Build commands

```bash
cd watch-app

# Debug APK (sideload-friendly)
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk

# Release APK (requires keystore at app/keystore/kobeai-release-key.jks)
./gradlew assembleRelease -PKOBEAI_API_BASE=https://your-app.replit.app/
# -> app/build/outputs/apk/release/app-release.apk
```

To create the release keystore:
```bash
mkdir -p app/keystore
keytool -genkey -v -keystore app/keystore/kobeai-release-key.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias kobeai
```
Then uncomment `signingConfig = signingConfigs.getByName("release")` in
`app/build.gradle.kts`.

## Sideloading onto a Wear OS device

```bash
# Pair watch over ADB-WiFi (Settings -> Developer options -> Wireless debugging)
adb pair <ip>:<pair-port>
adb connect <ip>:<port>

adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Kiosk mode

The app declares `android:lockTaskMode="if_whitelisted"` and a device-admin
receiver. To run as a true kiosk (no home / back), provision the device as
device-owner:

```bash
adb shell dpm set-device-owner com.kobeai.watch/.admin.DeviceAdminReceiver
```

Without device-owner provisioning, the app still launches but the kiosk lock
calls become no-ops.

## Known limitations

- The watch's `OutlinedTextField` uses Material 3 because Wear Compose's
  Material 2 doesn't ship a multi-line text field. On real Wear hardware
  consider replacing with `RemoteInputIntent` for better voice/keyboard input.
- The `OfflineDataManager` keeps preloaded answers for `photosynthesis`,
  `2+2`, `capital of tanzania`, `kilimanjaro` only. Extend the map for more
  cached responses.
- Auth tokens issued by the watch login endpoint are demo strings — wire
  these into a real session/JWT scheme before going to production.

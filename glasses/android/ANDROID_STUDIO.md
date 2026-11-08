# Opening this in Android Studio

Everything here has been compiled and packaged, by this container and by
`Glasses Android` CI, but **nothing has run on a phone or on glasses**. That is
the whole point of moving to Android Studio: a debugger, a device, and a pair of
Rokid glasses can answer questions that no amount of compiling can.

Open **`glasses/android`**, not the repository root. The root is a pnpm
workspace; the Gradle project starts here.

## Toolchain

These are the versions the build actually ran on, not aspirations.

| Component     | This project | AGP 9.2 minimum |
| ------------- | ------------ | --------------- |
| AGP           | 9.2.1        | —               |
| Gradle        | 9.6.1        | 9.4.1           |
| Kotlin (KGP)  | 2.4.0        | 2.2.10          |
| JDK           | 21 verified  | 17              |
| compileSdk    | 36           | —               |
| SDK Build Tools | 36.0.0     | 36.0.0          |
| minSdk        | 29 (Android 10) | —            |

Kotlin is pinned at 2.4.0 to match the metadata xg.glass 0.3.0 ships; don't let
anything bump it independently of that dependency.

`local.properties` is gitignored. Android Studio writes its own with your
`sdk.dir`; you do not need to create one.

**Do not accept the AGP Upgrade Assistant's offer to downgrade.** Two things in
`app/build.gradle.kts` depend on AGP 9 behaviour and fail silently or loudly on
8.x: `buildFeatures { resValues = true }`, which AGP 9 requires before
`resValue()` is allowed at all, and the `sourceSets[...].kotlin.directories`
registration described below. If your Studio reports AGP 9.2.1 as newer than it
supports, either use a Studio from the preview channel or edit in Studio and
build from the terminal — `./gradlew` does not care what version of Studio is
installed.

## Before the first build

Both modules bundle a web app as their assets, and **neither builds without it**:

```sh
# from the repository root
pnpm install --frozen-lockfile
pnpm --filter @workspace/teacher-lens build    # required by :app
pnpm --filter @workspace/student-tablet build  # required by :student
```

`dist` is gitignored, so a fresh clone has neither. The `verifyLensAssets` and
`verifyStudentAssets` tasks run as part of `preBuild` and fail with the exact
command to run, so a forgotten build is a clear message rather than a confusing
one — but a Gradle *sync* succeeds without the assets and only the build fails,
which is the one way to be surprised by this.

## The two modules

| Module     | Application id      | Install on | Hardware |
| ---------- | ------------------- | ---------- | -------- |
| `:app` `companion` | `tz.kobe.glasses` | Teacher's Android phone | Rokid, over the xg.glass SDK |
| `:app` `rayneo` | `tz.kobe.glasses.rayneo` | The RayNeo X2 glasses themselves | On-device Camera2 |
| `:student` | `tz.kobe.student` | Student tablet | None — no Bluetooth, no bridge |

`companion` is the one that matters for pairing: it is the teacher's phone app,
and it is where the glasses SDK lives. Pick the **companion** build variant in
Studio's Build Variants panel; `rayneo` installed on a phone will happily use
the phone's own camera and look like it is working.

A debug `companion` build also offers a HeyCyan provider when
`app/libs/heycyan-sdk.aar` is present. Nothing in this repository fetches that
AAR, and `preCompanionReleaseBuild` fails while it exists. See the README.

## Where the native code is

```
app/src/main/java/tz/kobe/glasses/
  MainActivity.kt        WebView host + the KobeNative bridge (info/connect/
                         capture/display/speak/forget), permissions, reconnect
  Hardware.kt            The Hardware interface and the xg.glass adapter
  ConnectionService.kt   Foreground service holding the SDK session open
  RokidCredentials.kt    Keystore-encrypted licence + client secret
app/src/companion/java/tz/kobe/glasses/
  ProviderFactory.kt     Provider list, permissions, Rokid connect, forget
app/src/heycyan/   compiled only when the AAR is present
app/src/noheycyan/ the stub that stands in when it is not
student/src/main/java/tz/kobe/student/MainActivity.kt
```

Two notes for anyone editing `ProviderFactory.kt`:

The prefs keys in `forgetProvisioning` are **string literals copied from the
SDK's on-disk format, not its API**. `RokidGlassesClient` declares them as
`const val` in a *private* companion object, so Kotlin cannot name them even
though they are public static fields in the bytecode. An SDK upgrade that
renames a key will not break the build — it will quietly stop forgetting
pairings, which only a hardware test catches: forget the pairing, then walk the
old glasses back into range.

The HeyCyan source-set switch registers its directory with **both**
`kotlin.directories` and `java.directories`. AGP 9 keeps those as separate sets
seeded with `src/<flavour>/{java,kotlin}`, so adding to `java` alone leaves the
Kotlin compiler unable to see a `.kt` file sitting in the directory — which
surfaces as an unresolved reference at the call site, looking like a missing
declaration rather than a source set that was never handed over.

## What to do on real hardware first

In rough order of what would change the design if it came back wrong:

1. **Pair a Rokid pair.** Needs a developer client secret and the device's
   `.lc` licence from the Rokid developer console; neither is in this repository
   and neither can be faked. The interactive connect path gets a 10-minute
   budget because the licence file picker sits inside it.
2. **Forget, then walk the old glasses into range.** This is the only test of
   the literal prefs keys above.
3. **Run the ten-shot benchmark** (*Test capture speed* on the Connections
   screen). `CaptureScheduler` reports the interval the hardware actually held
   at the 95th percentile. Do this before promising anyone an exam-marking
   cadence — capture and transfer are separate operations, and a vendor command
   returning "photo taken" says nothing about the image being on the phone.
4. **Drop the connection** (walk out of range, turn the glasses off) and watch
   the 3/6/12/24/48/60-second reconnect ladder, then the notification's Pause
   action.
5. **Minimise the app** during a connection and confirm the foreground service
   keeps the session; then force-stop it and confirm reopening restores from
   encrypted provisioning.

The README's *Validation record and remaining gates* section lists the rest.

## Continuing the Claude session here

The conversation that produced this branch ran in a cloud container and cannot
be moved into Studio. What transfers is the branch, the commit messages, and
this file. To pick it up locally:

1. Install the Claude Code CLI, then the **Claude Code** plugin from the
   JetBrains Marketplace, and restart Studio. Android Studio is a supported
   JetBrains IDE.
2. Run `claude` in Studio's integrated terminal **from the repository root**,
   not from `glasses/android` — the Android project depends on the web apps
   above, and a session rooted here cannot build them.
3. From an external terminal instead, `/ide` connects to the running Studio.

`git log --oneline glasses/android` is the short version of how this got here;
the commit bodies carry the reasoning, including which earlier claims turned out
to be wrong.

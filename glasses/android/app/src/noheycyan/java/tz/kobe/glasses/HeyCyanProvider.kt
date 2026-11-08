package tz.kobe.glasses

import android.bluetooth.BluetoothAdapter

/**
 * HeyCyan, absent.
 *
 * The vendor SDK is not in this checkout, so the real provider in
 * src/heycyan is not compiled and this stub stands in its place. The project
 * builds, opens in Android Studio and ships Rokid without anyone having to
 * obtain a proprietary binary first — which is the point: a missing optional
 * SDK should cost a feature, not the build.
 *
 * `BuildConfig.HAS_HEYCYAN` is false in this configuration, so ProviderFactory
 * never offers the provider and this is unreachable. It exists to keep the
 * call site compiling.
 */
@Suppress("UNUSED_PARAMETER")
suspend fun heyCyanHardware(
    activity: MainActivity,
    bluetooth: BluetoothAdapter,
    onLost: () -> Unit,
): Hardware = error("The HeyCyan SDK is not in this build. See glasses/android/app/libs/README.md")

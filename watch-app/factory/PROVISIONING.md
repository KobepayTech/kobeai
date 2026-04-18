# KobeAI Watch — Factory Provisioning Guide

This document tells the watch factory exactly how to flash a Wear OS device
so that **KobeAI is the device owner and the only app the student can ever
launch**. Hand it to your OEM/factory partner along with the signed APK
(`app-release-signed.apk`) and the SHA-256 fingerprint from
`factory-provisioning.txt`.

---

## What "device owner" means

A **device owner** is an Android app the system has granted full management
authority. It is a one-time, pre-FRP designation set during initial setup
(before any user account exists). Once set, it cannot be removed by the
user — only by a full factory wipe. Our app needs device-owner status so
it can lock the watch into kiosk mode and disable the status bar.

---

## App identity (what the factory needs)

| Field | Value |
|---|---|
| Package name | `com.kobeai.watch` |
| Admin component | `com.kobeai.watch/com.kobeai.watch.admin.DeviceAdminReceiver` |
| Min SDK | 30 (Wear OS 3) |
| Target SDK | 34 (Wear OS 4) |
| Signing cert SHA-256 | *(see `factory-provisioning.txt` next to the APK in the GitHub Actions build artifact)* |
| APK file | `app-release-signed.apk` |

---

## Provisioning method 1 — `adb` (engineering / small batches)

For dev kits and pilot units. Pre-installs the APK in `/system/priv-app/`
or via `adb install`, then sets device owner via shell:

```bash
adb install -r app-release-signed.apk
adb shell dpm set-device-owner com.kobeai.watch/.admin.DeviceAdminReceiver
```

The device must have **no existing user accounts** when this runs (factory
fresh or after `adb shell pm wipe-data`). On success the shell prints:

```
Success: Device owner set to package ComponentInfo{...}
```

---

## Provisioning method 2 — NFC bump (production line)

The standard Wear OS factory flow. The factory's "programmer" device
(another Android phone running their provisioning DPC) NFC-bumps each
fresh watch on the welcome screen. The bump payload is a Java
`Properties` bundle with these keys:

```properties
# device_owner_provisioning.properties
android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_NAME=com.kobeai.watch
android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME=com.kobeai.watch/com.kobeai.watch.admin.DeviceAdminReceiver
android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM=<BASE64URL_OF_SHA256_FROM_FACTSHEET>
android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION=https://kobeai.replit.app/downloads/app-release-signed.apk
android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED=false
android.app.extra.PROVISIONING_SKIP_ENCRYPTION=false
android.app.extra.PROVISIONING_WIFI_SSID=<factory-line-wifi>
android.app.extra.PROVISIONING_WIFI_PASSWORD=<factory-line-wifi-pwd>
android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE=WPA
```

**Important:** the `PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM` value is
the base64-url-safe (no padding) form of the SHA-256 from the factsheet.
Convert the colon-separated hex into base64-url like this:

```bash
SHA256_HEX="aabbcc..."   # paste from factory-provisioning.txt, lowercase, no colons
echo -n "$SHA256_HEX" | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='
```

---

## Provisioning method 3 — QR code (Wear OS 3+ recommended)

On a fresh watch, tap the welcome screen six times — Android opens the
QR-code provisioning camera. Print this QR (regenerate per build with the
correct SHA-256 + APK URL):

```json
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
    "com.kobeai.watch/com.kobeai.watch.admin.DeviceAdminReceiver",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM":
    "<BASE64URL_OF_SHA256>",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
    "https://kobeai.replit.app/downloads/app-release-signed.apk",
  "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": false,
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": false,
  "android.app.extra.PROVISIONING_WIFI_SSID": "<factory-line-wifi>",
  "android.app.extra.PROVISIONING_WIFI_PASSWORD": "<factory-line-wifi-pwd>",
  "android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE": "WPA"
}
```

Paste the JSON into any QR generator (e.g. `qrencode -o provisioning.png`).
The factory operator scans it with the watch camera and provisioning
proceeds automatically, ending with our `MainActivity` taking over the
screen.

---

## What the app does after provisioning

The moment our `DeviceAdminReceiver.onProfileProvisioningComplete()` fires,
KobeAI:

1. Whitelists itself for lock-task pinning.
2. Removes all system-UI affordances (`LOCK_TASK_FEATURE_NONE` — no home,
   no overview, no notifications).
3. Disables the status bar pull-down.
4. Disables the keyguard / lockscreen.
5. Disables the camera.
6. Adds user restrictions: no factory reset, no safe-boot, no USB file
   transfer, no debugging, no external storage mount, no new accounts, no
   account modification, no NFC beam-out, no app uninstall.
7. Launches `MainActivity`, which immediately enters lock-task mode and
   immersive fullscreen.

From this point the watch boots straight into KobeAI, can never leave it,
and the only way to recover the device is a full factory wipe via the
boot-loader (which the device owner *cannot* prevent — that escape hatch
is reserved for legitimate hardware recovery).

---

## Verification checklist (factory QA)

After provisioning each unit, the line operator should confirm:

- [ ] Watch boots straight into the KobeAI login screen (no system setup wizard)
- [ ] Status bar is gone (no swipe-down quick settings)
- [ ] Side-button does not return to a watchface
- [ ] `adb shell dumpsys device_policy | grep "Device Owner"` shows our package
- [ ] `adb shell dumpsys activity activities | grep "Lock task mode"` shows `LOCKED_PINNED`
- [ ] Camera is disabled (try long-press side-button)
- [ ] Settings → System shows "Managed by KobeAI"

If any check fails, wipe and re-provision. **Do not** ship a unit that
isn't in `LOCKED_PINNED` — students will be able to escape the app.

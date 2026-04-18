package com.kobeai.watch.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class DeviceAdminReceiver : DeviceAdminReceiver() {

    private val tag = "KobeWatchDPC"

    override fun onEnabled(context: Context, intent: Intent) {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = ComponentName(context, DeviceAdminReceiver::class.java)
        applyKioskPolicies(dpm, admin, context.packageName)
    }

    /**
     * Called by the system at the very end of device-owner provisioning
     * (NFC bump, QR enrollment, ADB `dpm set-device-owner`). Re-applies all
     * kiosk policies so the watch is locked down before the user ever sees
     * the launcher.
     */
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = ComponentName(context, DeviceAdminReceiver::class.java)
        applyKioskPolicies(dpm, admin, context.packageName)

        // Hand control over to MainActivity immediately so the kid sees
        // KobeAI, not the stock setup wizard.
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(launch)
        }
    }

    private fun applyKioskPolicies(
        dpm: DevicePolicyManager,
        admin: ComponentName,
        pkg: String,
    ) {
        // Every call below is wrapped — we may be running as a regular
        // device admin (not device owner) on dev builds, in which case
        // most of these throw SecurityException and we just no-op.
        runCatching { dpm.setLockTaskPackages(admin, arrayOf(pkg)) }
            .onFailure { Log.w(tag, "setLockTaskPackages: ${it.message}") }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            runCatching {
                dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
            }.onFailure { Log.w(tag, "setLockTaskFeatures: ${it.message}") }
        }

        // Kill the status bar pull-down (notifications + quick settings)
        // when not in lock-task mode. Only works for device owner.
        runCatching { dpm.setStatusBarDisabled(admin, true) }
            .onFailure { Log.w(tag, "setStatusBarDisabled: ${it.message}") }

        // Disable the lockscreen entirely — students should never see it.
        runCatching { dpm.setKeyguardDisabled(admin, true) }
            .onFailure { Log.w(tag, "setKeyguardDisabled: ${it.message}") }

        // Hard-disable the camera (no privacy concerns for parents).
        runCatching { dpm.setCameraDisabled(admin, true) }
            .onFailure { Log.w(tag, "setCameraDisabled: ${it.message}") }

        // Block factory reset, USB file transfer, debugging, OEM unlock,
        // safe-boot, mounting external storage, and adding new accounts.
        // These are the standard "locked-down student device" restrictions.
        val restrictions = listOf(
            android.os.UserManager.DISALLOW_FACTORY_RESET,
            android.os.UserManager.DISALLOW_SAFE_BOOT,
            android.os.UserManager.DISALLOW_USB_FILE_TRANSFER,
            android.os.UserManager.DISALLOW_DEBUGGING_FEATURES,
            android.os.UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA,
            android.os.UserManager.DISALLOW_ADD_USER,
            android.os.UserManager.DISALLOW_MODIFY_ACCOUNTS,
            android.os.UserManager.DISALLOW_OUTGOING_BEAM,
            android.os.UserManager.DISALLOW_UNINSTALL_APPS,
        )
        for (r in restrictions) {
            runCatching { dpm.addUserRestriction(admin, r) }
                .onFailure { Log.w(tag, "addUserRestriction $r: ${it.message}") }
        }
    }
}

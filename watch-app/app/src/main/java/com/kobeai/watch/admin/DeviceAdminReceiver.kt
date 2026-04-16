package com.kobeai.watch.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent

class DeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val adminComponent = ComponentName(context, DeviceAdminReceiver::class.java)
        dpm.setLockTaskPackages(adminComponent, arrayOf(context.packageName))
        dpm.setCameraDisabled(adminComponent, true)
    }
}

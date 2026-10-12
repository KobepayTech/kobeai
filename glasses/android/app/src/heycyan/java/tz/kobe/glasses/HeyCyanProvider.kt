package tz.kobe.glasses

import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import androidx.appcompat.app.AlertDialog
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * The real HeyCyan provider. Compiled only when app/libs/heycyan-sdk.aar is
 * present — see the source-set switch in app/build.gradle.kts, and the stub in
 * src/noheycyan that takes its place otherwise.
 *
 * Unlike Rokid there is no vendor pairing flow to defer to, so the scan and the
 * picker are ours.
 */
suspend fun heyCyanHardware(
    activity: MainActivity,
    bluetooth: BluetoothAdapter,
    onLost: () -> Unit,
): Hardware {
    val found = linkedMapOf<String, String>()
    val scanner = checkNotNull(bluetooth.bluetoothLeScanner)
    var failure: Int? = null
    val callback = object : ScanCallback() {
        override fun onScanResult(type: Int, result: ScanResult) {
            val device = result.device
            val name = result.scanRecord?.deviceName ?: device.name ?: "Unnamed device"
            found[device.address] = "$name (${device.address})"
        }
        override fun onScanFailed(code: Int) { failure = code }
    }
    try { scanner.startScan(callback); delay(7000) } finally { scanner.stopScan(callback) }
    check(failure == null && found.isNotEmpty()) { "No Bluetooth glasses found" }
    val addresses = found.keys.toList()
    val choice = chooseDevice(activity, found.values.toTypedArray())
    return HeyCyanHardware(activity, addresses[choice], onLost)
}

private suspend fun chooseDevice(activity: MainActivity, names: Array<String>): Int =
    suspendCancellableCoroutine { continuation ->
        val dialog = AlertDialog.Builder(activity).setTitle("Choose your HeyCyan glasses")
            .setItems(names) { _, index -> if (continuation.isActive) continuation.resume(index) }
            .setNegativeButton("Cancel") { _, _ -> continuation.cancel() }
            .setOnCancelListener { continuation.cancel() }.create()
        continuation.invokeOnCancellation { activity.runOnUiThread { dialog.dismiss() } }
        dialog.show()
    }

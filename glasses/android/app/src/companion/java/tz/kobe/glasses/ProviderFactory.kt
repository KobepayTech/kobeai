package tz.kobe.glasses

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.pm.PackageManager
import android.os.Build
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

object ProviderFactory {
    val providers = listOf("moyoung")
    suspend fun create(activity: MainActivity, provider: String, scope: CoroutineScope,
                       automatic: Boolean = false, onLost: () -> Unit): Hardware {
        require(provider in providers)
        val permissions = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 31) {
            permissions += listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else permissions += Manifest.permission.ACCESS_FINE_LOCATION
        if (automatic) {
            check(MoYoungPairing.automatic(activity)) { "Pair glasses first" }
            check(permissions.all { ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED })
        } else activity.ensurePermissions(permissions.toTypedArray())
        val bluetooth = activity.getSystemService(BluetoothManager::class.java).adapter
        check(bluetooth != null && bluetooth.isEnabled) { "Enable Bluetooth" }
        val address = MoYoungPairing.address(activity) ?: run {
            check(!automatic)
            val found = java.util.concurrent.ConcurrentHashMap<String, String>()
            val scanner = checkNotNull(bluetooth.bluetoothLeScanner)
            val failure = java.util.concurrent.atomic.AtomicInteger(0)
            val callback = object : ScanCallback() {
                override fun onScanResult(type: Int, result: ScanResult) {
                    val name = result.scanRecord?.deviceName ?: result.device.name ?: "Unnamed device"
                    found[result.device.address] = "$name (${result.device.address})"
                }
                override fun onScanFailed(code: Int) { failure.set(code) }
            }
            try { scanner.startScan(callback); delay(7000) } finally { scanner.stopScan(callback) }
            check(failure.get() == 0 && found.isNotEmpty()) { "No glasses found" }
            val choices = found.entries.sortedBy { it.value }
            val selected = suspendCancellableCoroutine<Int> { continuation ->
                val dialog = AlertDialog.Builder(activity).setTitle("Choose your MoYoung / DA ECHO glasses")
                    .setItems(choices.map { it.value }.toTypedArray()) { _, index ->
                        if (continuation.isActive) continuation.resume(index)
                    }.setNegativeButton("Cancel") { _, _ -> continuation.cancel() }
                    .setOnCancelListener { continuation.cancel() }.create()
                continuation.invokeOnCancellation { activity.runOnUiThread { dialog.dismiss() } }
                dialog.show()
            }
            choices[selected].key
        }
        val delegate = MoYoungHardware(activity, address, onLost)
        return object : Hardware by delegate {
            override suspend fun connect() {
                delegate.connect()
                MoYoungPairing.save(activity, address)
            }
        }
    }
}

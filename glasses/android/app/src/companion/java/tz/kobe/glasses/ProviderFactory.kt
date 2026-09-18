package tz.kobe.glasses

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.os.Build
import android.text.InputType
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import com.xgglass.device.rokid.RokidGlassesClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

object ProviderFactory {
    val providers = listOf("rokid", "heycyan")
    suspend fun create(activity: MainActivity, provider: String, scope: CoroutineScope, onLost: () -> Unit): Hardware {
        require(provider in providers)
        val permissions = mutableListOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 31) permissions += listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        if (Build.VERSION.SDK_INT >= 33) permissions += Manifest.permission.NEARBY_WIFI_DEVICES
        activity.ensurePermissions(permissions.toTypedArray())
        val bluetooth = activity.getSystemService(BluetoothManager::class.java).adapter
        check(bluetooth != null && bluetooth.isEnabled) { "Enable Bluetooth first" }
        return when (provider) {
            "rokid" -> {
                val secret = promptSecret(activity)
                val license = activity.pickLicense()
                XgHardware(RokidGlassesClient(activity, RokidGlassesClient.RokidOptions(
                    authorization = RokidGlassesClient.RokidAuthorization(license, secret)
                )), scope, onLost)
            }
            else -> {
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
                HeyCyanHardware(activity, addresses[choice], onLost)
            }
        }
    }
    private suspend fun promptSecret(activity: MainActivity): String = suspendCancellableCoroutine { continuation ->
        val input = EditText(activity).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        val dialog = AlertDialog.Builder(activity).setTitle("Rokid developer connection")
            .setMessage("Enter the developer client secret, then select this device's .lc licence file. Credentials remain in memory for this connection.")
            .setView(input).setPositiveButton("Choose licence") { _, _ ->
                val secret = input.text.toString().trim(); input.text.clear()
                if (continuation.isActive) {
                    if (secret.isBlank()) continuation.resumeWithException(IllegalArgumentException("Client secret required"))
                    else continuation.resume(secret)
                }
            }.setNegativeButton("Cancel") { _, _ -> continuation.cancel() }
            .setOnCancelListener { continuation.cancel() }.create()
        continuation.invokeOnCancellation { activity.runOnUiThread { dialog.dismiss() } }
        dialog.show()
    }
    private suspend fun chooseDevice(activity: MainActivity, names: Array<String>): Int = suspendCancellableCoroutine { continuation ->
        val dialog = AlertDialog.Builder(activity).setTitle("Choose your HeyCyan glasses")
            .setItems(names) { _, index -> if (continuation.isActive) continuation.resume(index) }
            .setNegativeButton("Cancel") { _, _ -> continuation.cancel() }
            .setOnCancelListener { continuation.cancel() }.create()
        continuation.invokeOnCancellation { activity.runOnUiThread { dialog.dismiss() } }
        dialog.show()
    }
}

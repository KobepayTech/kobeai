package tz.kobe.glasses

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.os.Build
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
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

    /**
     * The budget handed to RokidOptions.connectTimeoutMs, which the SDK wraps
     * around its whole connect: cached-MAC reconnect, then scan, then init, then
     * the BT socket, then Wi-Fi P2P. It is set explicitly rather than inherited,
     * so an SDK upgrade cannot silently move it out from under the watchdog in
     * MainActivity that has to stay above it.
     */
    const val ROKID_CONNECT_TIMEOUT_MS = 30_000L

    /**
     * Forgetting a pairing has to forget it everywhere, and the Rokid client keeps
     * a reconnect cache of its own: RokidGlassesClient.ensureBluetoothConnected
     * reads socket_uuid and mac_address out of its "xgglass_rokid_bt_reconnect"
     * preferences and dials that device before it will scan for any other. Clearing
     * only our credentials left the SDK still bound to the previous glasses, so a
     * teacher who forgot the pairing to move the phone to a different pair would
     * silently be reconnected to the old one whenever it was in range — which, in a
     * staffroom holding several pairs, is most of the time. The SDK's own
     * clearReconnectInfo() is private, but it publishes these key names for exactly
     * this purpose.
     */
    fun forgetProvisioning(activity: MainActivity) {
        RokidCredentials.forget(activity)
        activity.getSharedPreferences(RokidGlassesClient.PREFS_BT, android.content.Context.MODE_PRIVATE)
            .edit()
            .remove(RokidGlassesClient.PREF_KEY_SOCKET_UUID)
            .remove(RokidGlassesClient.PREF_KEY_MAC_ADDRESS)
            .commit()
    }
    suspend fun create(activity: MainActivity, provider: String, scope: CoroutineScope, automatic: Boolean = false, onLost: () -> Unit): Hardware {
        require(provider in providers)
        // From API 31 the manifest declares BLUETOOTH_SCAN neverForLocation, so a
        // BLE scan needs no location permission at all. Asking anyway was not
        // harmless: Android 12+ offers the teacher Precise or Approximate, and
        // picking Approximate leaves ACCESS_FINE_LOCATION denied — which the
        // all-granted checks below then turned into a refused Rokid connection,
        // over a permission this app never uses to locate anyone. Only API 29–30,
        // where a BLE scan genuinely requires it, still asks.
        val permissions = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 31) {
            permissions += listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            permissions += listOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
        }
        if (Build.VERSION.SDK_INT >= 33) permissions += Manifest.permission.NEARBY_WIFI_DEVICES
        // Rokid holds the connection open behind a foreground-service notification
        // whose Pause action is the only way to stop automatic reconnection from
        // outside the app. On API 33+ that notification is silently suppressed
        // without POST_NOTIFICATIONS, so ask — but never fail the connection over
        // it, which is why it is optional rather than required.
        val optional = if (provider == "rokid" && Build.VERSION.SDK_INT >= 33)
            arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray<String>()
        if (automatic) {
            check(provider == "rokid" && RokidCredentials.automatic(activity)) { "Setup required" }
            check(permissions.all { ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED }) { "Permissions required" }
        } else activity.ensurePermissions(permissions.toTypedArray(), optional)
        val bluetooth = activity.getSystemService(BluetoothManager::class.java).adapter
        check(bluetooth != null && bluetooth.isEnabled) { "Enable Bluetooth first" }
        return when (provider) {
            "rokid" -> {
                val saved = RokidCredentials.load(activity)
                check(!automatic || saved != null)
                val secret = saved?.second ?: promptSecret(activity)
                val license = saved?.first ?: activity.pickLicense()
                val delegate = XgHardware(RokidGlassesClient(activity, RokidGlassesClient.RokidOptions(
                    connectTimeoutMs = ROKID_CONNECT_TIMEOUT_MS,
                    authorization = RokidGlassesClient.RokidAuthorization(license, secret)
                )), scope, onLost, ROKID_CONNECT_TIMEOUT_MS)
                object : Hardware by delegate {
                    private var remembered = false
                    override suspend fun connect() {
                        delegate.connect()
                        if (!remembered) {
                            RokidCredentials.save(activity, license, secret)
                            remembered = true
                        }
                    }
                }
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
            .setMessage("Enter the developer client secret, then select this device's .lc licence file. After successful pairing, this setup is encrypted on this phone for automatic reconnection. Use Forget pairing to remove it.")
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

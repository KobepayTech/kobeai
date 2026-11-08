package tz.kobe.glasses

import android.Manifest
import android.bluetooth.BluetoothManager
import android.os.Build
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.text.InputType
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import com.xgglass.device.rokid.RokidGlassesClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

object ProviderFactory {
    /**
     * HeyCyan is a development-only provider.
     *
     * Its SDK is a proprietary AAR obtained outside any licence we hold, so it
     * exists here to be *evaluated* on hardware we own — measured with
     * CaptureScheduler — and not to be shipped. Two guards in
     * app/build.gradle.kts keep that true: a companion *release* build refuses
     * to run while the AAR is present, and the provider is compiled at all only
     * when it is. A checkout without the SDK builds and ships Rokid normally,
     * which is why a missing optional SDK costs a feature rather than the
     * build.
     */
    val providers: List<String> =
        if (BuildConfig.DEBUG && BuildConfig.HAS_HEYCYAN) listOf("rokid", "heycyan")
        else listOf("rokid")

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
     * staffroom holding several pairs, is most of the time.
     *
     * The names below are copied rather than referenced, and that is the honest
     * description of what they are. RokidGlassesClient declares them as const val
     * in a companion object that is *private*, so although each one is a public
     * static field in the bytecode, Kotlin will not let us name it — an earlier
     * version of this code read them from the SDK and did not compile. There is no
     * public clearReconnectInfo() either. So this depends on the SDK's on-disk
     * format, not on its API: an upgrade that renames a key will not break the
     * build, it will quietly stop forgetting. That is what the pairing test on real
     * hardware is for — forget, then walk the old glasses into range.
     */
    private const val ROKID_PREFS_BT = "xgglass_rokid_bt_reconnect"
    private const val ROKID_PREF_SOCKET_UUID = "socket_uuid"
    private const val ROKID_PREF_MAC_ADDRESS = "mac_address"

    fun forgetProvisioning(activity: MainActivity) {
        RokidCredentials.forget(activity)
        activity.getSharedPreferences(ROKID_PREFS_BT, android.content.Context.MODE_PRIVATE)
            .edit()
            .remove(ROKID_PREF_SOCKET_UUID)
            .remove(ROKID_PREF_MAC_ADDRESS)
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
        val optional = if (Build.VERSION.SDK_INT >= 33)
            arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray<String>()
        if (automatic) {
            check(RokidCredentials.automatic(activity)) { "Setup required" }
            check(permissions.all { ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED }) { "Permissions required" }
        } else activity.ensurePermissions(permissions.toTypedArray(), optional)
        val bluetooth = activity.getSystemService(BluetoothManager::class.java).adapter
        check(bluetooth != null && bluetooth.isEnabled) { "Enable Bluetooth first" }
        if (provider == "heycyan") return heyCyanHardware(activity, bluetooth, onLost)
        val saved = RokidCredentials.load(activity)
        check(!automatic || saved != null)
        val secret = saved?.second ?: promptSecret(activity)
        val license = saved?.first ?: activity.pickLicense()
        val delegate = XgHardware(RokidGlassesClient(activity, RokidGlassesClient.RokidOptions(
            connectTimeoutMs = ROKID_CONNECT_TIMEOUT_MS,
            authorization = RokidGlassesClient.RokidAuthorization(license, secret)
        )), scope, onLost, ROKID_CONNECT_TIMEOUT_MS)
        return object : Hardware by delegate {
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
}

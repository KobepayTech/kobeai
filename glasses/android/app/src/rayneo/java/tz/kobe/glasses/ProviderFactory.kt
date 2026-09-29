package tz.kobe.glasses

import android.Manifest
import com.xgglass.device.rayneo.runtime.RayNeoRuntimeGlassesClient
import kotlinx.coroutines.CoroutineScope

object ProviderFactory {
    val providers = listOf("rayneo")
    suspend fun create(activity: MainActivity, provider: String, scope: CoroutineScope, automatic: Boolean = false, onLost: () -> Unit): Hardware {
        require(provider == "rayneo")
        // Install this flavor on RayNeo X2 itself, not on a phone. The runtime
        // captures that Android device's camera; it does not connect over BLE.
        activity.ensurePermissions(arrayOf(Manifest.permission.CAMERA))
        return XgHardware(RayNeoRuntimeGlassesClient(activity), scope, onLost)
    }
}

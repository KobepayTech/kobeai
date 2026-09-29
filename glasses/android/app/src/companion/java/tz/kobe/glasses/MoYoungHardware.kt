package tz.kobe.glasses

import android.content.Context
import com.moyoung.glasses.CRPBleClient
import com.moyoung.glasses.conn.CRPBleConnection
import com.moyoung.glasses.conn.CRPBleDevice
import com.moyoung.glasses.conn.listener.CRPAiDialogueListener
import com.moyoung.glasses.conn.listener.CRPBleConnectionStateListener
import com.moyoung.glasses.conn.protos.TakePhoto
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** Uses the SDK's AI-photo callback. Bulk Wi-Fi sync and live streaming are not exposed. */
class MoYoungHardware(context: Context, private val address: String,
                      private val onLost: () -> Unit) : Hardware {
    private val client = CRPBleClient.create(context.applicationContext)
    private var device: CRPBleDevice? = null
    private var connection: CRPBleConnection? = null
    @Volatile private var generation = 0
    @Volatile private var connected = false
    @Volatile private var pendingPhoto: CompletableDeferred<File>? = null
    @Volatile private var pendingBattery: CompletableDeferred<Int>? = null

    override suspend fun connect() {
        disconnect()
        val epoch = generation
        val ready = CompletableDeferred<Unit>()
        try {
            val nextDevice = checkNotNull(client.getBleDevice(address))
            device = nextDevice
            val next = checkNotNull(nextDevice.connect())
            connection = next
            next.setConnectionStateListener { state ->
                if (generation == epoch) {
                    when (state) {
                        CRPBleConnectionStateListener.STATE_CONNECTED -> {
                            connected = true
                            ready.complete(Unit)
                        }
                        CRPBleConnectionStateListener.STATE_CONNECTING -> Unit
                        else -> {
                            val wasConnected = connected
                            connected = false
                            val error = IOException("MoYoung disconnected")
                            ready.completeExceptionally(error)
                            pendingPhoto?.completeExceptionally(error)
                            pendingBattery?.completeExceptionally(error)
                            if (wasConnected) onLost()
                        }
                    }
                }
            }
            next.setBatteryListener { battery ->
                if (generation == epoch) pendingBattery?.complete(battery.lvl.coerceIn(0, 100))
            }
            next.setAiDialogueListener(object : CRPAiDialogueListener {
                override fun onDialogueStart() = Unit
                override fun onDialogueAudioChange(bytes: ByteArray?) = Unit
                override fun onDialogueStop(isTimeOut: Boolean) {
                    if (generation == epoch && isTimeOut)
                        pendingPhoto?.completeExceptionally(IOException("Glasses photo timed out"))
                }
                override fun onDialogueImageChange(file: File?) {
                    if (generation == epoch && file != null) pendingPhoto?.complete(file)
                }
            })
            if (nextDevice.isConnected) { connected = true; ready.complete(Unit) }
            withTimeout(25_000) { ready.await() }
            next.syncTime()
        } catch (error: Exception) {
            disconnect()
            throw error
        }
    }

    override suspend fun disconnect() {
        generation++
        connected = false
        pendingPhoto?.cancel(); pendingPhoto = null
        pendingBattery?.cancel(); pendingBattery = null
        connection = null
        val old = device; device = null
        old?.disconnect()
    }

    override suspend fun capture(): ByteArray {
        check(connected && pendingPhoto == null) { "Connect glasses before capture" }
        val pending = CompletableDeferred<File>()
        pendingPhoto = pending
        try {
            // Mode 1 is AI recognition; its image arrives via CRPAiDialogueListener.
            checkNotNull(connection).takePhoto(checkNotNull(TakePhoto.PhotoMode.forNumber(1)))
            val file = withTimeout(45_000) { pending.await() }
            return withContext(Dispatchers.IO) {
                require(file.isFile && file.length() in 3..24_000_000)
                file.inputStream().use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        require(output.size() + count <= 24_000_000)
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
            }
        } catch (error: Exception) {
            // Invalidate listeners after an ambiguous timeout so a late callback cannot
            // satisfy the next capture. Reconnect creates a new listener generation.
            disconnect()
            onLost()
            throw error
        } finally { if (pendingPhoto === pending) pendingPhoto = null }
    }

    override suspend fun battery(): Int {
        check(connected && pendingBattery == null)
        val pending = CompletableDeferred<Int>(); pendingBattery = pending
        return try {
            checkNotNull(connection).queryBattery()
            withTimeout(5000) { pending.await() }
        } finally { if (pendingBattery === pending) pendingBattery = null }
    }
    override suspend fun display(text: String): Unit = error("MoYoung display is not supported")
    override suspend fun speak(text: String): Unit = error("Use Android speech output")
    override fun capabilities() = JSONObject().apply {
        put("camera", true); put("battery", true)
        put("cameraStream", false); put("microphone", false)
        put("display", false); put("speaker", false); put("speechSynthesis", false)
    }
}

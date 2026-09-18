package tz.kobe.glasses

import com.xgglass.core.AudioSource
import com.xgglass.core.ConnectionState
import com.xgglass.core.GlassesClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import org.json.JSONObject

interface Hardware {
    suspend fun connect()
    suspend fun disconnect()
    suspend fun capture(): ByteArray
    suspend fun display(text: String)
    suspend fun speak(text: String)
    fun capabilities(): JSONObject
}

/** Only advertise features exposed by this app, rather than every upstream feature. */
class XgHardware(private val client: GlassesClient, private val scope: CoroutineScope,
                 private val onLost: () -> Unit) : Hardware {
    private var watcher: Job? = null
    override suspend fun connect() {
        client.connect().getOrThrow()
        watcher = scope.launch {
            client.state.collectLatest { state ->
                if (state is ConnectionState.Disconnected || state is ConnectionState.Error) onLost()
            }
        }
    }
    override suspend fun disconnect() { watcher?.cancel(); watcher = null; client.disconnect() }
    override suspend fun capture(): ByteArray = client.capturePhoto().getOrThrow().jpegBytes
    override suspend fun display(text: String) { client.display(text).getOrThrow() }
    override suspend fun speak(text: String) { client.playAudio(AudioSource.Tts(text)).getOrThrow() }
    override fun capabilities() = JSONObject().apply {
        put("camera", client.capabilities.canCapturePhoto)
        put("display", client.capabilities.canDisplayText)
        put("speaker", client.capabilities.canPlayTts)
        put("speechSynthesis", client.capabilities.canPlayTts)
    }
}

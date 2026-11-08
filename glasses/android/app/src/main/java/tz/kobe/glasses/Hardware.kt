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
    /**
     * How long this hardware's own connect() may run before the vendor SDK gives
     * up and reports a diagnosis of its own. Any watchdog we wrap around connect()
     * has to sit above this, or it cancels the SDK mid-handshake and throws away
     * the better error. See RokidGlassesClient.doConnect, which wraps the whole
     * BT + Wi-Fi P2P handshake in withTimeout(options.connectTimeoutMs).
     */
    val connectBudgetMs: Long get() = DEFAULT_CONNECT_BUDGET_MS
}

const val DEFAULT_CONNECT_BUDGET_MS = 30_000L

/** Only advertise features exposed by this app, rather than every upstream feature. */
class XgHardware(private val client: GlassesClient, private val scope: CoroutineScope,
                 private val onLost: () -> Unit,
                 override val connectBudgetMs: Long = DEFAULT_CONNECT_BUDGET_MS) : Hardware {
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

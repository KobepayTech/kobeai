package tz.kobe.glasses

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var hardware: Hardware? = null
    private var permissionResult: CompletableDeferred<Boolean>? = null
    private var fileResult: CompletableDeferred<ByteArray>? = null
    private val gate = Mutex()
    private val permissionGate = Mutex()
    private val speechReady = CompletableDeferred<Unit>()
    private lateinit var tts: TextToSpeech
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        permissionResult?.complete(result.values.all { it }); permissionResult = null
    }
    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        try {
            check(uri != null) { "Licence selection cancelled" }
            val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytesBounded(65536) }
            check(bytes.isNotEmpty()) { "Empty licence file" }
            fileResult?.complete(bytes)
        } catch (e: Exception) { fileResult?.completeExceptionally(e) }
        fileResult = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) speechReady.complete(Unit)
            else speechReady.completeExceptionally(IllegalStateException("Android speech engine unavailable"))
        }
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        val assets = WebViewAssetLoader.Builder().addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = assets.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.scheme != "https" || request.url.host != HOST
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.origin.toString() != ORIGIN + "/" && request.origin.toString() != ORIGIN) { request.deny(); return }
                lifecycleScope.launch {
                    try {
                        val androidPermissions = request.resources.map {
                            when (it) {
                                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                                else -> error("Unsupported WebView permission")
                            }
                        }.toTypedArray()
                        ensurePermissions(androidPermissions)
                        request.grant(request.resources)
                    } catch (_: Exception) { request.deny() }
                }
            }
        }
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "Update Android System WebView" }
        WebViewCompat.addWebMessageListener(web, "KobeNative", setOf(ORIGIN)) { _, message, origin, mainFrame, reply ->
            if (!mainFrame || origin.toString() != ORIGIN) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            if (raw.length > 16_384) return@addWebMessageListener
            val request = try { JSONObject(raw) } catch (_: Exception) { return@addWebMessageListener }
            val id = request.optString("id")
            if (!id.matches(Regex("[0-9]{1,12}"))) return@addWebMessageListener
            lifecycleScope.launch {
                val response = JSONObject().put("id", id)
                try {
                    val result = withTimeout(75_000) { gate.withLock { dispatch(request) } }
                    response.put("result", result ?: JSONObject.NULL)
                } catch (e: Exception) {
                    // Never include user credentials or raw vendor exceptions in a JS/log response.
                    response.put("error", when (request.optString("method")) {
                        "connect" -> "Connection failed or cancelled. Check permissions, Bluetooth and the vendor licence."
                        "capture" -> "Photo capture failed. Reconnect glasses and try again."
                        else -> "Glasses operation failed: ${request.optString("method")}."
                    })
                }
                reply.postMessage(response.toString())
            }
        }
        web.loadUrl("$ORIGIN/index.html")
    }

    private suspend fun dispatch(request: JSONObject): Any? {
        val params = request.optJSONObject("params") ?: JSONObject()
        return when (request.getString("method")) {
            "info" -> JSONObject().put("version", 1).put("providers", JSONArray(ProviderFactory.providers))
            "connect" -> {
                hardware?.disconnect(); hardware = null
                val candidate = ProviderFactory.create(this, params.getString("provider"), lifecycleScope) { lost() }
                try {
                    candidate.connect(); hardware = candidate
                    JSONObject().put("capabilities", candidate.capabilities())
                } catch (e: Exception) {
                    withContext(NonCancellable) { candidate.disconnect() }
                    throw e
                }
            }
            "disconnect" -> { hardware?.disconnect(); hardware = null; null }
            "capture" -> {
                val bytes = requireHardware().capture()
                val jpeg = withContext(Dispatchers.Default) { normalizeJpeg(bytes) }
                JSONObject().put("jpeg", Base64.encodeToString(jpeg, Base64.NO_WRAP))
            }
            "display" -> { requireHardware().display(params.getString("text").take(2000)); null }
            "speak" -> { requireHardware().speak(params.getString("text").take(4000)); null }
            "phone.speak" -> {
                withTimeout(5000) { speechReady.await() }
                check(tts.speak(params.getString("text").take(4000), TextToSpeech.QUEUE_FLUSH, null, "kobe") != TextToSpeech.ERROR)
                null
            }
            else -> error("Unsupported operation")
        }
    }
    private fun requireHardware(): Hardware = checkNotNull(hardware) { "Connect glasses first" }
    private fun lost() {
        if (!isDestroyed) runOnUiThread {
            web.evaluateJavascript("window.KobeNative?.onmessage?.({data:JSON.stringify({event:'disconnected',reason:'Glasses disconnected'})})", null)
        }
    }
    suspend fun ensurePermissions(required: Array<String>) = permissionGate.withLock {
        val missing = required.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            check(permissionResult == null) { "Permission request still open" }
            val pending = CompletableDeferred<Boolean>(); permissionResult = pending
            permissions.launch(missing.toTypedArray())
            check(pending.await()) { "Required permission denied" }
        }
    }
    suspend fun pickLicense(): ByteArray {
        check(fileResult == null) { "Licence picker still open" }
        val pending = CompletableDeferred<ByteArray>(); fileResult = pending
        filePicker.launch(arrayOf("*/*"))
        return pending.await()
    }
    override fun onDestroy() {
        val old = hardware; hardware = null
        // Complete cleanup independently of the cancelled Activity lifecycle.
        kotlinx.coroutines.CoroutineScope(Dispatchers.Main).launch { old?.disconnect() }
        if (::tts.isInitialized) tts.shutdown()
        if (::web.isInitialized) { WebViewCompat.removeWebMessageListener(web, "KobeNative"); web.destroy() }
        super.onDestroy()
    }
    companion object { const val HOST = "appassets.androidplatform.net"; const val ORIGIN = "https://$HOST" }
}

private fun java.io.InputStream.readBytesBounded(max: Int): ByteArray {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        require(out.size() + count <= max) { "File too large" }
        out.write(buffer, 0, count)
    }
    return out.toByteArray()
}

private fun normalizeJpeg(bytes: ByteArray): ByteArray {
    require(bytes.size in 3..24_000_000 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte())
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 48_000_000)
    val options = BitmapFactory.Options().apply {
        while (maxOf(bounds.outWidth, bounds.outHeight) / (inSampleSize.coerceAtLeast(1) * 2) >= 1600) inSampleSize = inSampleSize.coerceAtLeast(1) * 2
    }
    val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options))
    try {
        val scale = minOf(1.0, 1600.0 / maxOf(bitmap.width, bitmap.height))
        val scaled = if (scale < 1) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
        return try { ByteArrayOutputStream().use { out -> check(scaled.compress(Bitmap.CompressFormat.JPEG, 85, out)); out.toByteArray() } }
        finally { if (scaled !== bitmap) scaled.recycle() }
    } finally { bitmap.recycle() }
}

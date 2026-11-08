package tz.kobe.student

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * K9 on a student's tablet.
 *
 * The whole app is the built web tablet, served from the APK's own assets over
 * a fixed https origin. That matters for two reasons: the page keeps working
 * with no internet, which is the normal state of a Tanzanian school; and the
 * camera and microphone permissions below are granted to one origin we ship,
 * never to a remote page.
 *
 * There is no native bridge here at all — no glasses, no Bluetooth, no speaker
 * identification. A student signs in, and that session *is* their identity
 * (docs/K9_ATTRIBUTION_GATES.md). Putting a child's biometrics in the loop when
 * they have already authenticated would replace a certainty with an inference.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val permissionGate = Mutex()
    private var pending: CompletableDeferred<Map<String, Boolean>>? = null

    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            pending?.complete(result)
            pending = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The tablet keeps its sign-in and recent questions in localStorage,
            // so this must survive; everything else is shut off.
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                assets.shouldInterceptRequest(request.url)

            /** Only our own origin loads in this window. */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
                request.url.scheme != "https" || request.url.host != HOST
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val origin = request.origin.toString().trimEnd('/')
                if (origin != ORIGIN) {
                    request.deny()
                    return
                }
                lifecycleScope.launch {
                    try {
                        ensure(
                            request.resources.map {
                                when (it) {
                                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                                    else -> error("Unsupported WebView permission")
                                }
                            }.toTypedArray(),
                        )
                        request.grant(request.resources)
                    } catch (_: Exception) {
                        // A refused camera is not a broken app: the tablet falls
                        // back to typing, and says so.
                        request.deny()
                    }
                }
            }
        }
        if (savedInstanceState == null) web.loadUrl("$ORIGIN/index.html")
    }

    /** Back inside the app before back out of it. */
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        web.restoreState(savedInstanceState)
    }

    private suspend fun ensure(required: Array<String>) = permissionGate.withLock {
        val granted = { p: String ->
            ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
        }
        val missing = required.filterNot(granted)
        if (missing.isNotEmpty()) {
            check(pending == null) { "Permission request still open" }
            val deferred = CompletableDeferred<Map<String, Boolean>>()
            pending = deferred
            permissions.launch(missing.toTypedArray())
            val result = deferred.await()
            check(required.all { result[it] ?: granted(it) }) { "Permission denied" }
        }
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
    }
}

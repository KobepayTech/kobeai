package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavController
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.CardDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.PrintApiService
import com.kobeai.watch.data.remote.PrintFile
import com.kobeai.watch.data.remote.PrintJobResponse
import com.kobeai.watch.data.remote.PrintPairingResponse
import com.kobeai.watch.data.remote.PrintSubmitRequest
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import retrofit2.HttpException
import timber.log.Timber
import javax.inject.Inject

/**
 * State machine for the print flow.
 *
 * The watch can't observe the NFC tap directly (the Pi reads the tag, not the
 * watch), so we discover the pairing by polling for a fresh pairing id that
 * was registered for this student. The server's recent-pairings lookup is
 * exposed via the standard pairing endpoint once we know the id; for the
 * pilot we ask the student to glance at the tap-box display (which can show
 * the last 4 chars of the pairing id) — but to keep things simple, we add a
 * lightweight server lookup endpoint via /print/pairing/{id} once the watch
 * gets it through a future per-student lookup.
 *
 * For v1, the screen does the next-best thing: it polls the server using the
 * watch session id (which the tap-box also sent) and the server returns the
 * most recent fresh pairing for that session. That endpoint is server-side
 * forward work; here we surface a clear "Tap your watch on the printer" UI
 * with a manual cancel.
 */
sealed interface PrintUi {
    data object WaitingForTap : PrintUi
    data class Picking(val pairing: PrintPairingResponse) : PrintUi
    data class Submitting(val file: PrintFile) : PrintUi
    data class Tracking(val job: PrintJobResponse) : PrintUi
    data class Done(val job: PrintJobResponse) : PrintUi
    data class Error(val message: String) : PrintUi
}

@HiltViewModel
class PrintViewModel @Inject constructor(
    private val api: PrintApiService,
    private val prefs: PreferencesManager
) : ViewModel() {

    private val _state = MutableStateFlow<PrintUi>(PrintUi.WaitingForTap)
    val state: StateFlow<PrintUi> = _state.asStateFlow()

    private var pollerStarted = false

    /** Begin polling the server for a pairing tied to this watch session. */
    fun startPolling() {
        if (pollerStarted) return
        pollerStarted = true
        viewModelScope.launch {
            val sessionId = prefs.getDeviceId()
            repeat(60) {                       // ~90 s
                if (_state.value !is PrintUi.WaitingForTap) return@launch
                try {
                    val resp = api.lookupPairingForSession(sessionId)
                    if (resp.code() == 200) {
                        val body = resp.body()
                        if (body != null) {
                            val pairing = api.getPairing(body.pairing_id)
                            _state.value = PrintUi.Picking(pairing)
                            return@launch
                        }
                    }
                } catch (e: Exception) {
                    Timber.w(e, "pairing poll error")
                }
                delay(1500)
            }
            if (_state.value is PrintUi.WaitingForTap) {
                _state.value = PrintUi.Error("No tap detected. Try again.")
            }
        }
    }

    fun pickFile(file: PrintFile) {
        val current = _state.value as? PrintUi.Picking ?: return
        _state.value = PrintUi.Submitting(file)
        viewModelScope.launch {
            try {
                val sig = signSubmit(current.pairing.pairing_id, file.id)
                val resp = api.submit(PrintSubmitRequest(current.pairing.pairing_id, file.id, sig))
                trackJob(resp.job_id)
            } catch (e: Exception) {
                Timber.e(e, "submit failed")
                _state.value = PrintUi.Error("Failed to send job")
            }
        }
    }

    /** Bind the submit to the watch that owns the pairing. */
    private fun signSubmit(pairingId: String, documentId: String): String {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(
            javax.crypto.spec.SecretKeySpec(
                com.kobeai.watch.BuildConfig.WATCH_HCE_SECRET.toByteArray(Charsets.UTF_8),
                "HmacSHA256"
            )
        )
        return mac.doFinal("$pairingId|$documentId".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    private fun trackJob(jobId: String) {
        viewModelScope.launch {
            repeat(120) {                      // poll up to ~2 min for slow printers
                try {
                    val job = api.getJob(jobId)
                    when (job.status) {
                        "done"   -> { _state.value = PrintUi.Done(job); return@launch }
                        "failed" -> { _state.value = PrintUi.Error(job.status_message); return@launch }
                        else     -> _state.value = PrintUi.Tracking(job)
                    }
                } catch (e: HttpException) {
                    Timber.w(e, "poll error")
                }
                delay(1000)
            }
            _state.value = PrintUi.Error("Print took too long")
        }
    }

    fun reset() { _state.value = PrintUi.WaitingForTap }
}

@Composable
fun PrintScreen(
    navController: NavController,
    vm: PrintViewModel = hiltViewModel(),
) {
    val ui by vm.state.collectAsState()

    LaunchedEffect(Unit) { vm.startPolling() }

    Scaffold(timeText = { TimeText() }) {
        when (val s = ui) {
            PrintUi.WaitingForTap -> WaitingForTapView()
            is PrintUi.Picking    -> FilePickerView(s.pairing) { vm.pickFile(it) }
            is PrintUi.Submitting -> StatusView("Sending…", s.file.name, showSpinner = true)
            is PrintUi.Tracking   -> StatusView(s.job.status_message, s.job.document_name, showSpinner = true)
            is PrintUi.Done       -> StatusView("Printed!", s.job.document_name, showSpinner = false, success = true) {
                vm.reset(); navController.popBackStack()
            }
            is PrintUi.Error      -> StatusView("Error", s.message, showSpinner = false, success = false) {
                vm.reset(); navController.popBackStack()
            }
        }
    }
}

@Composable
private fun WaitingForTapView() {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            "Tap watch on printer",
            style = MaterialTheme.typography.title3,
            color = Primary,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Hold your watch against the reader for 1–2 seconds",
            style = MaterialTheme.typography.caption2,
            color = Color.LightGray,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(16.dp))
        CircularProgressIndicator()
    }
}

@Composable
private fun FilePickerView(pairing: PrintPairingResponse, onPick: (PrintFile) -> Unit) {
    LazyColumn(modifier = Modifier.fillMaxSize().padding(8.dp)) {
        item {
            Text(
                pairing.printer.name,
                style = MaterialTheme.typography.title3,
                color = Primary,
                modifier = Modifier.padding(vertical = 6.dp)
            )
        }
        items(pairing.files) { file ->
            Card(
                onClick = { onPick(file) },
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
            ) {
                Column(modifier = Modifier.padding(10.dp)) {
                    Text(file.name, style = MaterialTheme.typography.button)
                    Text(
                        "${file.subject} • ${file.pages}p • ${file.size_kb} KB",
                        style = MaterialTheme.typography.caption2,
                        color = Color.LightGray
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusView(
    title: String,
    subtitle: String,
    showSpinner: Boolean,
    success: Boolean = true,
    onTap: (() -> Unit)? = null
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            title,
            style = MaterialTheme.typography.title3,
            color = if (success) Primary else Color(0xFFFF5252),
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(6.dp))
        Text(subtitle, style = MaterialTheme.typography.caption1, color = Color.LightGray, textAlign = TextAlign.Center)
        Spacer(Modifier.height(12.dp))
        if (showSpinner) CircularProgressIndicator()
        else if (onTap != null) {
            Card(onClick = onTap, modifier = Modifier.fillMaxWidth()) {
                Text("OK", modifier = Modifier.padding(8.dp), textAlign = TextAlign.Center)
            }
        }
    }
}

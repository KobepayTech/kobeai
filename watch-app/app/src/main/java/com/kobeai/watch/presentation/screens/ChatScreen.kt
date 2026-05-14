package com.kobeai.watch.presentation.screens

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavController
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import androidx.wear.input.RemoteInputIntentHelper
import androidx.wear.input.wearableExtender
import com.kobeai.watch.data.OfflineDataManager
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.TtsManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.QuestionRequest
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ChatViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager,
    val offline: OfflineDataManager,
    val tts: TtsManager
) : ViewModel()

data class ChatMessage(val content: String, val isUser: Boolean, val points: Int)

private const val REMOTE_INPUT_KEY = "kobe_chat_input"

/**
 * ChatScreen — text-first AI chat for Wear OS.
 *
 * Input model:
 *   - Primary: a focused BasicTextField that auto-focuses on screen entry.
 *     A paired Bluetooth keyboard's keystrokes go straight to it (system
 *     handles routing); Enter sends the message via the IME `Send` action.
 *   - Fallback: when keyboardEnabled = false OR the kid taps the input area
 *     and no hardware keyboard is attached, we launch the system RemoteInput
 *     activity (voice or watch mini-keyboard) via RemoteInputIntentHelper.
 *
 * Output model:
 *   - Visual: every reply renders as a chat bubble.
 *   - Audio: when audioEnabled, the AI's reply is spoken via TtsManager.
 *     Routing to BT earbuds is automatic — Wear OS picks the active output.
 *   - A speaker / mute toggle in the top bar lets the kid override mid-class
 *     without going to settings.
 */
@Composable
fun ChatScreen(
    navController: NavController,
    vm: ChatViewModel = hiltViewModel()
) {
    var messages by remember { mutableStateOf(listOf<ChatMessage>()) }
    var inputText by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current

    val audioEnabledFlow = vm.prefs.audioEnabled.collectAsState(initial = true)
    val keyboardEnabledFlow = vm.prefs.keyboardEnabled.collectAsState(initial = true)
    val audioEnabled = audioEnabledFlow.value
    val keyboardEnabled = keyboardEnabledFlow.value

    // Launches the system RemoteInput chooser (voice or on-watch keyboard)
    // and writes the result back into inputText, then sends it.
    val remoteInputLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data ?: return@rememberLauncherForActivityResult
            val results = RemoteInput.getResultsFromIntent(data) ?: return@rememberLauncherForActivityResult
            val typed = results.getCharSequence(REMOTE_INPUT_KEY)?.toString().orEmpty()
            if (typed.isNotBlank()) {
                inputText = typed
                sendQuestion(
                    vm = vm,
                    question = typed,
                    isLoading = isLoading,
                    onClear = { inputText = "" },
                    onMessage = { msg -> messages = messages + msg },
                    onLoading = { isLoading = it },
                    audioEnabled = audioEnabled,
                    scope = scope
                )
            }
        }
    }

    fun launchRemoteInput() {
        val remoteInputs = listOf(
            RemoteInput.Builder(REMOTE_INPUT_KEY)
                .setLabel("Ask KobeAI")
                .wearableExtender { setEmojisAllowed(false) }
                .build()
        )
        val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(intent, remoteInputs)
        remoteInputLauncher.launch(intent)
    }

    LaunchedEffect(Unit) {
        messages = listOf(ChatMessage("Hello! Ask me anything!", false, 0))
        // Pull the latest parent-controlled toggles from the server and mirror
        // them into local DataStore so the UI reflects what the parent set
        // (without it, parent flips never reach the watch). Failures are
        // silent — we keep using whatever's already in DataStore.
        try {
            val token = vm.prefs.getAuthToken()
            if (token != null) {
                val s = vm.api.getWatchSettings("Bearer $token")
                vm.prefs.setAudioEnabled(s.audio_enabled)
                vm.prefs.setKeyboardEnabled(s.keyboard_enabled)
                vm.prefs.setAdsEnabled(s.ads_enabled)
            }
        } catch (_: Exception) { /* offline / token expired — ignore */ }
    }

    // Auto-focus the input only after the BasicTextField is composed AND only
    // when the keyboard toggle is on. Keying off `keyboardEnabled` re-runs
    // when the parent toggle flips remotely. The small delay gives Compose a
    // frame to attach the FocusRequester before we call requestFocus —
    // otherwise we'd hit IllegalStateException on cold launch.
    LaunchedEffect(keyboardEnabled) {
        if (keyboardEnabled) {
            kotlinx.coroutines.delay(150)
            try { focusRequester.requestFocus() } catch (_: Exception) {}
        }
    }

    // Stop any in-flight TTS when the chat screen exits, so a long answer
    // doesn't keep talking through the kid's earbuds after they navigate
    // back home.
    DisposableEffect(Unit) {
        onDispose { vm.tts.stop() }
    }

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(lazyListState = listState) }
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Top bar: speaker / mute toggle. Tiny on-watch real estate so we
            // pack it into the same row as the time.
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(24.dp)
                        .clip(CircleShape)
                        .background(if (audioEnabled) Primary.copy(alpha = 0.2f) else Color.Transparent),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = if (audioEnabled) "\uD83D\uDD0A" else "\uD83D\uDD07",
                        modifier = Modifier
                            .padding(2.dp),
                        fontSize = 12.sp
                    )
                }
                Spacer(Modifier.width(4.dp))
                androidx.compose.material3.TextButton(
                    onClick = {
                        scope.launch {
                            val next = !audioEnabled
                            vm.prefs.setAudioEnabled(next)
                            if (!next) vm.tts.stop()
                        }
                    }
                ) {
                    Text(
                        if (audioEnabled) "Mute" else "Speak",
                        fontSize = 11.sp
                    )
                }
            }

            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                reverseLayout = true
            ) {
                items(messages.reversed()) { message ->
                    ChatBubble(message)
                }
                if (isLoading) {
                    item { LoadingIndicator() }
                }
            }

            Card(
                onClick = {
                    // Tapping the bubble itself opens the on-watch fallback
                    // input (voice or scribble) — cheap escape hatch when
                    // the BT keyboard is missing or out of battery.
                    if (!keyboardEnabled) launchRemoteInput()
                },
                modifier = Modifier.fillMaxWidth().padding(8.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (keyboardEnabled) {
                        BasicTextField(
                            value = inputText,
                            onValueChange = { inputText = it },
                            modifier = Modifier
                                .weight(1f)
                                .focusRequester(focusRequester),
                            singleLine = false,
                            maxLines = 3,
                            cursorBrush = SolidColor(Primary),
                            textStyle = TextStyle(
                                color = MaterialTheme.colors.onSurface,
                                fontSize = 13.sp
                            ),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                            keyboardActions = KeyboardActions(onSend = {
                                sendQuestion(
                                    vm = vm,
                                    question = inputText,
                                    isLoading = isLoading,
                                    onClear = { inputText = "" },
                                    onMessage = { msg -> messages = messages + msg },
                                    onLoading = { isLoading = it },
                                    audioEnabled = audioEnabled,
                                    scope = scope
                                )
                                keyboardController?.hide()
                            }),
                            decorationBox = { inner ->
                                if (inputText.isEmpty()) {
                                    Text(
                                        "Type or press Enter…",
                                        color = MaterialTheme.colors.onSurface.copy(alpha = 0.4f),
                                        fontSize = 13.sp
                                    )
                                }
                                inner()
                            }
                        )
                    } else {
                        Text(
                            "Tap to speak or type",
                            modifier = Modifier.weight(1f).padding(start = 4.dp),
                            color = MaterialTheme.colors.onSurface.copy(alpha = 0.6f),
                            fontSize = 12.sp
                        )
                    }

                    Button(
                        onClick = {
                            if (keyboardEnabled && inputText.isNotBlank()) {
                                sendQuestion(
                                    vm = vm,
                                    question = inputText,
                                    isLoading = isLoading,
                                    onClear = { inputText = "" },
                                    onMessage = { msg -> messages = messages + msg },
                                    onLoading = { isLoading = it },
                                    audioEnabled = audioEnabled,
                                    scope = scope
                                )
                            } else {
                                launchRemoteInput()
                            }
                        },
                        modifier = Modifier.padding(start = 4.dp).size(40.dp),
                        enabled = !isLoading && (keyboardEnabled || true)
                    ) {
                        Text(if (keyboardEnabled) ">" else "\uD83C\uDFA4")
                    }
                }
            }
        }
    }
}

private fun sendQuestion(
    vm: ChatViewModel,
    question: String,
    isLoading: Boolean,
    onClear: () -> Unit,
    onMessage: (ChatMessage) -> Unit,
    onLoading: (Boolean) -> Unit,
    audioEnabled: Boolean,
    scope: kotlinx.coroutines.CoroutineScope
) {
    if (question.isBlank() || isLoading) return
    onClear()
    onMessage(ChatMessage(question, true, 0))
    onLoading(true)
    scope.launch {
        try {
            val token = vm.prefs.getAuthToken() ?: throw Exception("Not logged in")
            val offlineAnswer = vm.offline.getOfflineAnswer(question)
            if (offlineAnswer != null) {
                onMessage(ChatMessage(offlineAnswer, false, 10))
                if (audioEnabled) vm.tts.speak(offlineAnswer)
            } else {
                try {
                    val response =
                        vm.api.askQuestion("Bearer $token", QuestionRequest(question))
                    onMessage(
                        ChatMessage(response.answer, false, response.points_earned)
                    )
                    if (audioEnabled) vm.tts.speak(response.answer)
                    vm.prefs.setWalletBalance(response.new_balance)
                } catch (e: Exception) {
                    vm.offline.queueQuestion(question, null)
                    onMessage(ChatMessage("Saved offline. Will answer soon!", false, 0))
                }
            }
        } catch (e: Exception) {
            onMessage(ChatMessage("Error: ${e.message}", false, 0))
        } finally {
            onLoading(false)
        }
    }
}

@Composable
fun ChatBubble(message: ChatMessage) {
    Card(
        onClick = {},
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(
                message.content,
                color = if (message.isUser) Primary else MaterialTheme.colors.onSurface
            )
            if (message.points > 0) {
                Text(
                    "+${message.points} points!",
                    style = MaterialTheme.typography.caption2,
                    color = Color(0xFFFFD700)
                )
            }
        }
    }
}

@Composable
fun LoadingIndicator() {
    Card(
        onClick = {},
        modifier = Modifier.fillMaxWidth().padding(8.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.Center
        ) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp))
            Spacer(modifier = Modifier.width(8.dp))
            Text("Thinking...")
        }
    }
}

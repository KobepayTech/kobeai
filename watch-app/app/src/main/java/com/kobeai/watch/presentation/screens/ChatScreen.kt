package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
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
import com.kobeai.watch.data.OfflineDataManager
import com.kobeai.watch.data.PreferencesManager
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
    val offline: OfflineDataManager
) : ViewModel()

data class ChatMessage(val content: String, val isUser: Boolean, val points: Int)

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

    LaunchedEffect(Unit) {
        messages = listOf(ChatMessage("Hello! Ask me anything!", false, 0))
    }

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(lazyListState = listState) }
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
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
                onClick = {},
                modifier = Modifier.fillMaxWidth().padding(8.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    androidx.compose.material3.OutlinedTextField(
                        value = inputText,
                        onValueChange = { inputText = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { androidx.compose.material3.Text("Ask KobeAI...") },
                        singleLine = false,
                        maxLines = 3,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = {
                            sendQuestion(
                                vm = vm,
                                question = inputText,
                                isLoading = isLoading,
                                onClear = { inputText = "" },
                                onMessage = { msg -> messages = messages + msg },
                                onLoading = { isLoading = it },
                                scope = scope
                            )
                        })
                    )

                    Button(
                        onClick = {
                            sendQuestion(
                                vm = vm,
                                question = inputText,
                                isLoading = isLoading,
                                onClear = { inputText = "" },
                                onMessage = { msg -> messages = messages + msg },
                                onLoading = { isLoading = it },
                                scope = scope
                            )
                        },
                        modifier = Modifier.padding(start = 4.dp).size(48.dp),
                        enabled = inputText.isNotBlank() && !isLoading
                    ) {
                        Text(">")
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
            } else {
                try {
                    val response =
                        vm.api.askQuestion("Bearer $token", QuestionRequest(question))
                    onMessage(
                        ChatMessage(response.answer, false, response.points_earned)
                    )
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

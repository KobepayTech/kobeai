package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavController
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.presentation.theme.Accent
import com.kobeai.watch.presentation.theme.ErrorRed
import com.kobeai.watch.presentation.theme.MutedText
import com.kobeai.watch.presentation.theme.Primary
import com.kobeai.watch.presentation.theme.PrimarySoft
import com.kobeai.watch.presentation.theme.Success
import com.kobeai.watch.presentation.theme.Surface
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class MiniAppRunnerViewModel @Inject constructor(
    private val api: ApiService,
    val prefs: PreferencesManager,
) : ViewModel() {
    data class State(
        val loading: Boolean = true,
        val name: String = "",
        val type: String = "",
        val manifest: Map<String, Any?>? = null,
        val finished: Boolean = false,
        val awardedKp: Int = 0,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var appId: Int = 0

    fun load(id: Int) {
        appId = id
        viewModelScope.launch {
            try {
                val token = prefs.getAuthToken().orEmpty()
                val resp = api.getStoreApp("Bearer $token", id)
                if (resp.manifest == null) {
                    _state.value = State(loading = false, error = "Install the app first.")
                } else {
                    _state.value = State(
                        loading = false,
                        name = resp.app.name,
                        type = resp.app.type,
                        manifest = resp.manifest,
                    )
                }
            } catch (e: Exception) {
                _state.value = State(loading = false, error = e.message ?: "Load failed")
            }
        }
    }

    fun complete() {
        viewModelScope.launch {
            try {
                val token = prefs.getAuthToken().orEmpty()
                val resp = api.completeStoreApp("Bearer $token", appId)
                _state.value = _state.value.copy(finished = true, awardedKp = resp.awarded_kp)
            } catch (_: Exception) {
                _state.value = _state.value.copy(finished = true, awardedKp = 0)
            }
        }
    }
}

@Composable
fun MiniAppRunnerScreen(
    appId: Int,
    navController: NavController,
    vm: MiniAppRunnerViewModel = hiltViewModel(),
) {
    LaunchedEffect(appId) { vm.load(appId) }
    val state by androidx.lifecycle.compose.collectAsStateWithLifecycle(
        vm.state, initialValue = MiniAppRunnerViewModel.State()
    )

    Scaffold(timeText = { TimeText() }) {
        Box(modifier = Modifier.fillMaxSize().padding(top = 22.dp, bottom = 12.dp, start = 8.dp, end = 8.dp)) {
            when {
                state.loading -> Centered { Text("Loading…", color = MutedText) }
                state.error != null -> Centered { Text(state.error!!, color = ErrorRed) }
                state.finished -> Finished(state.awardedKp) { navController.popBackStack() }
                else -> when (state.type) {
                    "flashcards" -> FlashcardsRunner(state.manifest!!) { vm.complete() }
                    "quiz" -> QuizRunner(state.manifest!!) { vm.complete() }
                    "reading" -> ReadingRunner(state.manifest!!) { vm.complete() }
                    "counter" -> CounterRunner(state.manifest!!) { vm.complete() }
                    "timer" -> TimerRunner(state.manifest!!) { vm.complete() }
                    else -> Centered { Text("Unsupported: ${state.type}", color = ErrorRed) }
                }
            }
        }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun Finished(kp: Int, onDone: () -> Unit) {
    Centered {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Done", fontWeight = FontWeight.Bold, color = Success)
            if (kp > 0) Text("+$kp KP", color = Accent, fontWeight = FontWeight.Bold)
            Chip(
                onClick = onDone,
                label = { Text("Close") },
                colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

@Suppress("UNCHECKED_CAST")
@Composable
private fun FlashcardsRunner(manifest: Map<String, Any?>, onDone: () -> Unit) {
    val cards = (manifest["cards"] as? List<Map<String, Any?>>).orEmpty()
    if (cards.isEmpty()) { Centered { Text("No cards") }; return }
    var idx by remember { mutableIntStateOf(0) }
    var flipped by remember { mutableStateOf(false) }
    val card = cards[idx]
    val front = (card["front"] as? String).orEmpty()
    val back = (card["back"] as? String).orEmpty()
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.SpaceBetween,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Card ${idx + 1} / ${cards.size}", color = MutedText, style = MaterialTheme.typography.caption2)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (flipped) Primary else Surface)
                .clickable { flipped = !flipped }
                .padding(16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (flipped) back else front,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (idx + 1 < cards.size) {
                Chip(
                    onClick = { idx++; flipped = false },
                    label = { Text("Next") },
                    colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                )
            } else {
                Chip(
                    onClick = onDone,
                    label = { Text("Finish") },
                    colors = ChipDefaults.primaryChipColors(backgroundColor = Accent),
                )
            }
        }
    }
}

@Suppress("UNCHECKED_CAST")
@Composable
private fun QuizRunner(manifest: Map<String, Any?>, onDone: () -> Unit) {
    val qs = (manifest["questions"] as? List<Map<String, Any?>>).orEmpty()
    if (qs.isEmpty()) { Centered { Text("No questions") }; return }
    var idx by remember { mutableIntStateOf(0) }
    var correct by remember { mutableIntStateOf(0) }
    var picked by remember { mutableStateOf<Int?>(null) }
    val q = qs[idx]
    val text = (q["q"] as? String).orEmpty()
    val choices = (q["choices"] as? List<String>).orEmpty()
    val answer = (q["answer"] as? Number)?.toInt() ?: 0
    val listState = rememberScalingLazyListState()

    Scaffold(
        timeText = {},
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            item { Text("Q${idx + 1} / ${qs.size}  ✓$correct", color = MutedText, style = MaterialTheme.typography.caption2) }
            item { Text(text, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center) }
            choices.forEachIndexed { i, c ->
                item {
                    val color = when {
                        picked == null -> Surface
                        i == answer -> Success
                        i == picked -> ErrorRed
                        else -> Surface
                    }
                    Chip(
                        onClick = {
                            if (picked == null) {
                                picked = i
                                if (i == answer) correct++
                            }
                        },
                        label = { Text(c) },
                        colors = ChipDefaults.secondaryChipColors(backgroundColor = color),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (picked != null) {
                item {
                    Chip(
                        onClick = {
                            if (idx + 1 < qs.size) { idx++; picked = null } else onDone()
                        },
                        label = { Text(if (idx + 1 < qs.size) "Next" else "Finish") },
                        colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@Suppress("UNCHECKED_CAST")
@Composable
private fun ReadingRunner(manifest: Map<String, Any?>, onDone: () -> Unit) {
    val pages = (manifest["pages"] as? List<Map<String, Any?>>).orEmpty()
    if (pages.isEmpty()) { Centered { Text("No content") }; return }
    var idx by remember { mutableIntStateOf(0) }
    val p = pages[idx]
    val title = (p["title"] as? String).orEmpty()
    val body = (p["body"] as? String).orEmpty()
    val listState = rememberScalingLazyListState()

    Scaffold(
        timeText = {},
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            item { Text(title, fontWeight = FontWeight.Bold) }
            item { Text(body, style = MaterialTheme.typography.caption1) }
            item {
                Chip(
                    onClick = { if (idx + 1 < pages.size) idx++ else onDone() },
                    label = { Text(if (idx + 1 < pages.size) "Next page" else "Finish") },
                    colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun CounterRunner(manifest: Map<String, Any?>, onDone: () -> Unit) {
    val target = ((manifest["target"] as? Number)?.toInt()) ?: 8
    val unit = (manifest["unit"] as? String) ?: "items"
    val label = (manifest["label"] as? String) ?: "Count"
    var count by remember { mutableIntStateOf(0) }
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.SpaceEvenly,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(label, color = MutedText)
        Text("$count / $target", fontWeight = FontWeight.Bold)
        Text(unit, color = MutedText, style = MaterialTheme.typography.caption2)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip(
                onClick = { if (count > 0) count-- },
                label = { Text("-") },
                colors = ChipDefaults.secondaryChipColors(backgroundColor = Surface),
            )
            Chip(
                onClick = { count++ },
                label = { Text("+1") },
                colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
            )
        }
        if (count >= target) {
            Chip(
                onClick = onDone,
                label = { Text("Finish") },
                colors = ChipDefaults.primaryChipColors(backgroundColor = Accent),
            )
        }
    }
}

@Composable
private fun TimerRunner(manifest: Map<String, Any?>, onDone: () -> Unit) {
    val total = ((manifest["duration_sec"] as? Number)?.toInt()) ?: 1500
    val label = (manifest["label"] as? String) ?: "Focus"
    var remaining by remember { mutableIntStateOf(total) }
    var running by remember { mutableStateOf(false) }
    LaunchedEffect(running) {
        while (running && remaining > 0) {
            delay(1000)
            remaining--
        }
        if (remaining == 0 && running) {
            running = false
            onDone()
        }
    }
    val mm = remaining / 60
    val ss = remaining % 60
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.SpaceEvenly,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(label, color = MutedText)
        Text(
            "%02d:%02d".format(mm, ss),
            fontWeight = FontWeight.Bold,
            style = MaterialTheme.typography.display2,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip(
                onClick = { running = !running },
                label = { Text(if (running) "Pause" else "Start") },
                colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
            )
            Chip(
                onClick = { running = false; remaining = total },
                label = { Text("Reset") },
                colors = ChipDefaults.secondaryChipColors(backgroundColor = Surface),
            )
        }
    }
}

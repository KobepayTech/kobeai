package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavController
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ActiveExam
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import javax.inject.Inject

/**
 * Fullscreen exam countdown.
 *
 * Polls /v1/watch/exam/active every 10 s. When `active` is true, the watch is
 * supposed to take over the entire screen with a giant timer — no other UI is
 * accessible until the supervisor finishes the exam.
 *
 * Server-of-truth model:
 *   - active: count down from `ends_at` (timestamp) using local time.
 *   - paused: hold `remaining_seconds` static, dimmed.
 *   - finished/no exam: navigate back home.
 */
@HiltViewModel
class ExamCountdownViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager,
) : ViewModel()

private fun parseIsoMillis(iso: String?): Long? {
    if (iso.isNullOrBlank()) return null
    return try {
        java.time.Instant.parse(iso).toEpochMilli()
    } catch (_: Exception) { null }
}

private fun fmtCountdown(secs: Int): String {
    val s = secs.coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

@Composable
fun ExamCountdownScreen(
    navController: NavController,
    vm: ExamCountdownViewModel = hiltViewModel(),
) {
    var exam by remember { mutableStateOf<ActiveExam?>(null) }
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    var checkedOnce by remember { mutableStateOf(false) }

    // Tick local clock every second (smooth countdown for active exams).
    LaunchedEffect(Unit) {
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1000)
        }
    }

    // Poll the server every 10 s for status / time changes.
    LaunchedEffect(Unit) {
        val token = vm.prefs.getAuthToken() ?: return@LaunchedEffect
        while (true) {
            try {
                val resp = vm.api.getActiveExam("Bearer $token")
                checkedOnce = true
                exam = resp.exam
                if (!resp.active) {
                    // Supervisor finished the exam — return home.
                    navController.navigate("home") {
                        popUpTo("home") { inclusive = true }
                    }
                    break
                }
            } catch (_: Exception) {}
            delay(10_000)
        }
    }

    val current = exam
    val remaining = when {
        current == null -> 0
        current.status == "active" -> {
            val endsMs = parseIsoMillis(current.ends_at)
            if (endsMs != null) ((endsMs - nowMs) / 1000).toInt().coerceAtLeast(0) else current.remaining_seconds
        }
        else -> current.remaining_seconds // paused or scheduled: hold steady
    }

    val warning = current?.status == "active" && remaining in 1..300
    val critical = current?.status == "active" && remaining in 1..60
    val paused = current?.status == "paused"

    val bg = when {
        critical -> Color(0xFF6B0000)
        warning -> Color(0xFF6B4A00)
        paused -> Color(0xFF222222)
        else -> Color.Black
    }

    Box(
        modifier = Modifier.fillMaxSize().background(bg).padding(16.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (current == null) {
            Text(
                if (checkedOnce) "Waiting for supervisor…" else "Loading exam…",
                color = Color.White,
            )
        } else {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    "EXAM IN PROGRESS",
                    color = Primary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 11.sp,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    current.title,
                    color = Color.White,
                    style = MaterialTheme.typography.caption1,
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    fmtCountdown(remaining),
                    color = if (critical) Color(0xFFFF6B6B) else if (paused) Color.LightGray else Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = if (remaining >= 3600) 36.sp else 44.sp,
                )
                Spacer(Modifier.height(8.dp))
                if (paused) {
                    Text("PAUSED", color = Color(0xFFFFC857), fontWeight = FontWeight.Bold, fontSize = 12.sp)
                } else if (current.seconds_added != 0) {
                    val mins = current.seconds_added / 60
                    Text(
                        if (mins >= 0) "Supervisor +${mins} min" else "Supervisor ${mins} min",
                        color = Color.LightGray,
                        fontSize = 10.sp,
                    )
                }
            }
        }
    }
}

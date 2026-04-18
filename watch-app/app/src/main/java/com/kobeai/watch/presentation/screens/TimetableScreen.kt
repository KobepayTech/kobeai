package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Schedule
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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavController
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.CardDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.TimetablePeriod
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

/**
 * Today's timetable, pulled from /v1/watch/timetable/today.
 *
 * The "current" period is highlighted in green so a glance at the watch tells
 * the kid what subject they're supposed to be in. Background polling in the
 * watch service triggers a vibration on subject change — this screen is the
 * detail view.
 */
@HiltViewModel
class TimetableViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager,
) : ViewModel()

private val DAY_NAMES = arrayOf("", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

private fun fmtMinute(min: Int): String {
    val h = min / 60
    val m = min % 60
    return "%02d:%02d".format(h, m)
}

@Composable
fun TimetableScreen(
    navController: NavController,
    vm: TimetableViewModel = hiltViewModel(),
) {
    var periods by remember { mutableStateOf<List<TimetablePeriod>>(emptyList()) }
    var dayOfWeek by remember { mutableStateOf(0) }
    var serverMinute by remember { mutableStateOf(0) }
    var isLoading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            val token = vm.prefs.getAuthToken() ?: run {
                error = "Please log in"; return@LaunchedEffect
            }
            val today = vm.api.getTimetableToday("Bearer $token")
            periods = today.periods
            dayOfWeek = today.day_of_week
            // Best-effort current minute from server so highlight is correct
            // even if the watch's local clock drifted.
            try {
                val cur = vm.api.getTimetableCurrent("Bearer $token")
                serverMinute = cur.server_minute
            } catch (_: Exception) {}
        } catch (e: Exception) {
            error = "Could not load timetable"
        } finally {
            isLoading = false
        }
    }

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
    ) {
        when {
            isLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            error != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(error!!, color = MaterialTheme.colors.error)
            }
            periods.isEmpty() -> Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Schedule, contentDescription = null, tint = Primary, modifier = Modifier.size(36.dp))
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "No periods scheduled today.",
                        style = MaterialTheme.typography.caption2,
                    )
                }
            }
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item {
                    Text(
                        DAY_NAMES.getOrNull(dayOfWeek) ?: "Today",
                        style = MaterialTheme.typography.title3,
                        color = Primary,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                    )
                }
                items(periods) { p ->
                    val isCurrent = serverMinute in p.start_minute until p.end_minute
                    PeriodRow(p, isCurrent)
                }
            }
        }
    }
}

@Composable
private fun PeriodRow(p: TimetablePeriod, isCurrent: Boolean) {
    Card(
        onClick = {},
        backgroundPainter = CardDefaults.cardBackgroundPainter(),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(8.dp)) {
            Text(
                p.subject,
                style = MaterialTheme.typography.button,
                color = if (isCurrent) Primary else MaterialTheme.colors.onSurface,
                fontWeight = if (isCurrent) FontWeight.Bold else FontWeight.Normal,
            )
            Text(
                "${fmtMinute(p.start_minute)} – ${fmtMinute(p.end_minute)}" +
                    (p.room?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.caption2,
                color = Color.LightGray,
            )
            if (isCurrent) {
                Text("NOW", style = MaterialTheme.typography.caption3, color = Primary, fontWeight = FontWeight.Bold)
            }
        }
    }
}

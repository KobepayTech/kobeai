package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavController
import androidx.wear.compose.material.Card
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
import com.kobeai.watch.data.remote.LeaderboardEntry
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

/**
 * Class leaderboard screen for the watch.
 *
 * Pulls /v1/watch/leaderboard, which returns up to 20 students ranked by
 * SUM(best score per quiz). The caller's row is highlighted via `is_me`.
 * Falls back to a global leaderboard when the student isn't in any class.
 */
@HiltViewModel
class LeaderboardViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager,
) : ViewModel()

@Composable
fun LeaderboardScreen(
    navController: NavController,
    vm: LeaderboardViewModel = hiltViewModel(),
) {
    var rows by remember { mutableStateOf<List<LeaderboardEntry>>(emptyList()) }
    var scope by remember { mutableStateOf("class") }
    var isLoading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            val token = vm.prefs.getAuthToken()
            if (token == null) {
                error = "Please log in"
                return@LaunchedEffect
            }
            val resp = vm.api.getLeaderboard("Bearer $token")
            rows = resp.leaderboard
            scope = resp.scope
        } catch (e: Exception) {
            error = "Could not load leaderboard"
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
            rows.isEmpty() -> Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.EmojiEvents, contentDescription = null, tint = Primary, modifier = Modifier.size(36.dp))
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "No quiz attempts yet. Take a quiz to climb the board!",
                        style = MaterialTheme.typography.caption2,
                    )
                }
            }
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                    ) {
                        Icon(Icons.Filled.EmojiEvents, contentDescription = null, tint = Primary, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(4.dp))
                        Text(
                            if (scope == "class") "Class leaderboard" else "Global leaderboard",
                            style = MaterialTheme.typography.title3,
                            color = Primary,
                        )
                    }
                }
                items(rows) { row -> LeaderboardRow(row) }
            }
        }
    }
}

@Composable
private fun LeaderboardRow(row: LeaderboardEntry) {
    val highlight = row.is_me
    Card(
        onClick = {},
        backgroundPainter = androidx.wear.compose.material.CardDefaults.cardBackgroundPainter(),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Rank pill
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(if (highlight) Primary else Color.DarkGray),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "${row.rank}",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                )
            }
            Spacer(Modifier.size(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    if (highlight) "You" else row.student_name,
                    style = MaterialTheme.typography.button,
                    color = if (highlight) Primary else MaterialTheme.colors.onSurface,
                    fontWeight = if (highlight) FontWeight.Bold else FontWeight.Normal,
                )
                Text(
                    "${row.quizzes_taken} quiz${if (row.quizzes_taken == 1) "" else "zes"} · avg ${row.avg_score}%",
                    style = MaterialTheme.typography.caption2,
                    color = Color.LightGray,
                )
            }
            Text(
                "${row.total_points}",
                style = MaterialTheme.typography.title3,
                color = if (highlight) Primary else MaterialTheme.colors.onSurface,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

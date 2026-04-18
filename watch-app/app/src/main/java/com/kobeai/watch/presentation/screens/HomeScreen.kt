package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.presentation.theme.Accent
import com.kobeai.watch.presentation.theme.MutedText
import com.kobeai.watch.presentation.theme.Navy
import com.kobeai.watch.presentation.theme.Primary
import com.kobeai.watch.presentation.theme.PrimaryDark
import com.kobeai.watch.presentation.theme.PrimarySoft
import com.kobeai.watch.presentation.theme.Surface
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class HomeViewModel @Inject constructor(val prefs: PreferencesManager) : ViewModel()

private data class MenuItem(
    val route: String,
    val title: String,
    val subtitle: String,
    val glyph: String,
    val tint: Color = Primary,
)

@Composable
fun HomeScreen(
    navController: NavController,
    vm: HomeViewModel = hiltViewModel()
) {
    val studentName by vm.prefs.studentName.collectAsStateWithLifecycle(initialValue = "")
    val walletBalance by vm.prefs.walletBalance.collectAsStateWithLifecycle(initialValue = 0)

    val firstName = studentName.substringBefore(' ').ifBlank { "Student" }

    val items = listOf(
        MenuItem("chat",         "Ask KobeAI",     "Homework help",        "AI",  Primary),
        MenuItem("quizzes",      "Quizzes",        "Practice & earn KP",   "Q",   PrimarySoft),
        MenuItem("leaderboard",  "Leaderboard",    "Class ranking",        "L",   Accent),
        MenuItem("timetable",    "Timetable",      "Today's schedule",     "T",   Primary),
        MenuItem("attendance",   "Check In",       "Daily attendance",     "C",   PrimarySoft),
        MenuItem("wallet",       "Wallet",         "$walletBalance KP",    "KP",  Accent),
        MenuItem("print",        "Tap to Print",   "NFC printer",          "P",   Primary),
        MenuItem("subscription", "Subscription",   "Plan & expiry",        "S",   PrimarySoft),
        MenuItem("bluetooth",    "Bluetooth",      "Pair earbuds",         "B",   Primary),
    )

    val listState = rememberScalingLazyListState()

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) }
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            item { HeroHeader(firstName = firstName, walletBalance = walletBalance) }
            items(items) { item ->
                MenuChip(item) { navController.navigate(item.route) }
            }
        }
    }
}

@Composable
private fun HeroHeader(firstName: String, walletBalance: Int) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(
                Brush.linearGradient(
                    colors = listOf(Primary, PrimaryDark)
                )
            )
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Column {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.18f)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = firstName.take(1).uppercase(),
                        color = Color.White,
                        style = MaterialTheme.typography.title3,
                        fontWeight = FontWeight.Bold
                    )
                }
                Column {
                    Text(
                        text = "Habari",
                        color = Color.White.copy(alpha = 0.8f),
                        style = MaterialTheme.typography.caption2
                    )
                    Text(
                        text = firstName,
                        color = Color.White,
                        style = MaterialTheme.typography.title3,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "Wallet",
                    color = Color.White.copy(alpha = 0.8f),
                    style = MaterialTheme.typography.caption1
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "$walletBalance",
                        color = Color.White,
                        style = MaterialTheme.typography.title2,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = " KP",
                        color = Accent,
                        style = MaterialTheme.typography.caption1,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(start = 4.dp, top = 2.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun MenuChip(item: MenuItem, onClick: () -> Unit) {
    Chip(
        modifier = Modifier.fillMaxWidth(),
        onClick = onClick,
        colors = ChipDefaults.chipColors(
            backgroundColor = Surface,
            contentColor = Color.White,
            secondaryContentColor = MutedText
        ),
        icon = {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(item.tint.copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = item.glyph,
                    color = item.tint,
                    style = MaterialTheme.typography.caption1,
                    fontWeight = FontWeight.Bold
                )
            }
        },
        label = {
            Text(
                text = item.title,
                style = MaterialTheme.typography.button,
                color = Color.White
            )
        },
        secondaryLabel = {
            Text(
                text = item.subtitle,
                style = MaterialTheme.typography.caption2,
                color = MutedText
            )
        }
    )
}

package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class HomeViewModel @Inject constructor(val prefs: PreferencesManager) : ViewModel()

@Composable
fun HomeScreen(
    navController: NavController,
    vm: HomeViewModel = hiltViewModel()
) {
    val studentName by vm.prefs.studentName.collectAsStateWithLifecycle(initialValue = "")
    val walletBalance by vm.prefs.walletBalance.collectAsStateWithLifecycle(initialValue = 0)

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) }
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(12.dp)) {
            Card(
                onClick = {},
                modifier = Modifier.fillMaxWidth(),
                backgroundPainter = androidx.wear.compose.material.CardDefaults.cardBackgroundPainter(
                    startBackgroundColor = Primary,
                    endBackgroundColor = Primary
                )
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        "Hello, $studentName!",
                        color = Color.White,
                        style = MaterialTheme.typography.title3
                    )
                    Text(
                        "$walletBalance KP",
                        color = Color.White,
                        style = MaterialTheme.typography.body2
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            MenuCard("Ask KobeAI", "Get help with homework") { navController.navigate("chat") }
            MenuCard("Quizzes", "Practice and earn points") { navController.navigate("quizzes") }
            MenuCard("Check In", "Mark daily attendance") { navController.navigate("attendance") }
            MenuCard("Wallet", "$walletBalance points") { navController.navigate("wallet") }
            MenuCard("Print", "Tap watch on printer") { navController.navigate("print") }
        }
    }
}

@Composable
fun MenuCard(title: String, subtitle: String, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(title, style = MaterialTheme.typography.button)
            Text(subtitle, style = MaterialTheme.typography.caption2)
        }
    }
}

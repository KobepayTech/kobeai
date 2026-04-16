package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavController
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.QuizSummary
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class QuizListViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager
) : ViewModel()

@Composable
fun QuizListScreen(
    navController: NavController,
    vm: QuizListViewModel = hiltViewModel()
) {
    var quizzes by remember { mutableStateOf<List<QuizSummary>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        try {
            val token = vm.prefs.getAuthToken() ?: return@LaunchedEffect
            val response = vm.api.getQuizzes("Bearer $token")
            quizzes = response.quizzes
        } catch (_: Exception) {
            // Handle error
        } finally {
            isLoading = false
        }
    }

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) }
    ) {
        if (isLoading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(quizzes) { quiz ->
                    QuizCard(quiz) { navController.navigate("quiz/${quiz.id}") }
                }
            }
        }
    }
}

@Composable
fun QuizCard(quiz: QuizSummary, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(quiz.title, style = MaterialTheme.typography.button, color = Primary)
            Text(quiz.subject, style = MaterialTheme.typography.caption2)
            Spacer(modifier = Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Q ${quiz.questions_count}", style = MaterialTheme.typography.caption2)
                Text("Pts ${quiz.points_possible}", style = MaterialTheme.typography.caption2)
                Text("${quiz.duration_minutes}m", style = MaterialTheme.typography.caption2)
            }
        }
    }
}

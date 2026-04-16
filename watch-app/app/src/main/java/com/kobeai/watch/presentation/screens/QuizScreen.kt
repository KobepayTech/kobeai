package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.StartQuizResponse
import com.kobeai.watch.data.remote.SubmitQuizRequest
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class QuizViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager
) : ViewModel()

@Composable
fun QuizScreen(
    quizId: String,
    navController: NavController,
    vm: QuizViewModel = hiltViewModel()
) {
    var quizData by remember { mutableStateOf<StartQuizResponse?>(null) }
    var currentIndex by remember { mutableStateOf(0) }
    var selectedAnswer by remember { mutableStateOf<String?>(null) }
    var answers by remember { mutableStateOf(mapOf<String, String>()) }
    var isLoading by remember { mutableStateOf(true) }
    var isSubmitting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            val token = vm.prefs.getAuthToken() ?: return@LaunchedEffect
            quizData = vm.api.startQuiz("Bearer $token", quizId)
        } catch (_: Exception) {
        } finally {
            isLoading = false
        }
    }

    if (isLoading || quizData == null) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val questions = quizData!!.questions
    val currentQuestion = questions[currentIndex]

    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator() }
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(8.dp)) {
            Text(
                "${currentIndex + 1}/${questions.size}",
                style = MaterialTheme.typography.caption1,
                color = MaterialTheme.colors.primary
            )

            Card(
                onClick = {},
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(currentQuestion.text, modifier = Modifier.padding(12.dp))
            }

            Spacer(modifier = Modifier.height(8.dp))

            currentQuestion.options.forEach { option ->
                Card(
                    onClick = { selectedAnswer = option.take(1) },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(option, modifier = Modifier.padding(12.dp))
                }
                Spacer(modifier = Modifier.height(4.dp))
            }

            Button(
                onClick = {
                    if (selectedAnswer != null) {
                        val newAnswers = answers.toMutableMap()
                        newAnswers[currentQuestion.id] = selectedAnswer!!
                        answers = newAnswers

                        if (currentIndex < questions.size - 1) {
                            currentIndex++
                            selectedAnswer = null
                        } else {
                            scope.launch {
                                isSubmitting = true
                                try {
                                    val token = vm.prefs.getAuthToken()!!
                                    val response = vm.api.submitQuiz(
                                        "Bearer $token",
                                        quizData!!.quiz_id,
                                        SubmitQuizRequest(answers)
                                    )
                                    vm.prefs.setWalletBalance(response.new_balance)
                                    navController.navigate("home") {
                                        popUpTo("home") { inclusive = true }
                                    }
                                } catch (_: Exception) {
                                } finally {
                                    isSubmitting = false
                                }
                            }
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = selectedAnswer != null && !isSubmitting
            ) {
                if (isSubmitting) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp))
                } else {
                    Text(if (currentIndex < questions.size - 1) "Next" else "Submit")
                }
            }
        }
    }
}

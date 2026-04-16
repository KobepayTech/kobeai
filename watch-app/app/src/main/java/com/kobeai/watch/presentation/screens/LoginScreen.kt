package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.LoginRequest
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class LoginViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager
) : ViewModel()

@Composable
fun LoginScreen(
    onLoginSuccess: () -> Unit,
    vm: LoginViewModel = hiltViewModel()
) {
    var studentId by remember { mutableStateOf("TEST001") }
    var pin by remember { mutableStateOf("1234") }
    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) }
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text("KobeAI", style = MaterialTheme.typography.title1, color = Primary)
            Text(
                "Student Login",
                style = MaterialTheme.typography.body2,
                modifier = Modifier.padding(bottom = 24.dp)
            )

            androidx.compose.material3.OutlinedTextField(
                value = studentId,
                onValueChange = { studentId = it.uppercase() },
                label = { androidx.compose.material3.Text("Student ID") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )

            Spacer(modifier = Modifier.height(8.dp))

            androidx.compose.material3.OutlinedTextField(
                value = pin,
                onValueChange = { if (it.length <= 4 && it.all { c -> c.isDigit() }) pin = it },
                label = { androidx.compose.material3.Text("PIN") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
            )

            errorMessage?.let {
                Text(
                    it,
                    color = MaterialTheme.colors.error,
                    style = MaterialTheme.typography.caption2
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            Button(
                onClick = {
                    scope.launch {
                        isLoading = true
                        errorMessage = null
                        try {
                            val response = vm.api.login(
                                LoginRequest(studentId, pin, vm.prefs.getDeviceId())
                            )
                            if (response.success) {
                                vm.prefs.setAuthToken(response.token)
                                vm.prefs.setStudentInfo(studentId, response.student_name)
                                vm.prefs.setWalletBalance(response.wallet_balance)
                                vm.prefs.setLoggedIn(true)
                                onLoginSuccess()
                            } else {
                                errorMessage = "Invalid credentials"
                            }
                        } catch (e: Exception) {
                            errorMessage = "Connection error"
                        } finally {
                            isLoading = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isLoading
            ) {
                if (isLoading) CircularProgressIndicator(modifier = Modifier.size(20.dp))
                else Text("Login")
            }
        }
    }
}

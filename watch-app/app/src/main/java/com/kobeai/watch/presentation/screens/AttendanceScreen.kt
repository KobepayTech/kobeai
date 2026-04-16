package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavController
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.presentation.theme.Success
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class AttendanceViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager
) : ViewModel()

@Composable
fun AttendanceScreen(
    navController: NavController,
    vm: AttendanceViewModel = hiltViewModel()
) {
    var checkedIn by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Scaffold(timeText = { TimeText() }) {
        Column(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            if (!checkedIn) {
                Button(
                    onClick = {
                        scope.launch {
                            isLoading = true
                            try {
                                val token = vm.prefs.getAuthToken()!!
                                val response = vm.api.checkIn("Bearer $token")
                                if (response.success) {
                                    checkedIn = true
                                    message = response.message
                                    vm.prefs.setWalletBalance(response.new_balance)
                                }
                            } catch (e: Exception) {
                                message = "Connection error"
                            } finally {
                                isLoading = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isLoading
                ) {
                    if (isLoading) CircularProgressIndicator(modifier = Modifier.size(20.dp))
                    else Text("Check In Now")
                }
            } else {
                Card(
                    onClick = {},
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(message, modifier = Modifier.padding(16.dp), color = Success)
                }
            }
        }
    }
}

package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavController
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.CardDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.SubscriptionResponse
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SubscriptionViewModel @Inject constructor(
    private val api: ApiService,
    private val prefs: PreferencesManager
) : ViewModel() {
    var state by mutableStateOf<SubscriptionUiState>(SubscriptionUiState.Loading)
        private set

    fun load() {
        state = SubscriptionUiState.Loading
        viewModelScope.launch {
            try {
                val token = prefs.token.first()
                if (token.isNullOrBlank()) {
                    state = SubscriptionUiState.Error("Please log in again")
                    return@launch
                }
                val res = api.getSubscription("Bearer $token")
                state = SubscriptionUiState.Loaded(res)
            } catch (e: Exception) {
                state = SubscriptionUiState.Error(e.message ?: "Network error")
            }
        }
    }
}

sealed class SubscriptionUiState {
    object Loading : SubscriptionUiState()
    data class Loaded(val data: SubscriptionResponse) : SubscriptionUiState()
    data class Error(val message: String) : SubscriptionUiState()
}

@Composable
fun SubscriptionScreen(
    navController: NavController,
    vm: SubscriptionViewModel = hiltViewModel()
) {
    LaunchedEffect(Unit) { vm.load() }
    val scroll = rememberScrollState()

    Scaffold(timeText = { TimeText() }) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scroll)
                .padding(12.dp)
        ) {
            when (val s = vm.state) {
                is SubscriptionUiState.Loading -> Text(
                    "Loading...",
                    style = MaterialTheme.typography.body2
                )
                is SubscriptionUiState.Error -> Text(
                    s.message,
                    color = Color.Red,
                    style = MaterialTheme.typography.body2
                )
                is SubscriptionUiState.Loaded -> Loaded(s.data)
            }
        }
    }
}

@Composable
private fun Loaded(data: SubscriptionResponse) {
    val bg = when (data.severity) {
        "urgent" -> Color(0xFFD32F2F)
        "warning" -> Color(0xFFF57C00)
        "info" -> Color(0xFF1976D2)
        else -> Color(0xFF00A86B)
    }
    Card(
        onClick = {},
        modifier = Modifier.fillMaxWidth(),
        backgroundPainter = CardDefaults.cardBackgroundPainter(
            startBackgroundColor = bg,
            endBackgroundColor = bg
        )
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(
                data.plan?.replaceFirstChar { it.uppercase() } ?: "No plan",
                color = Color.White,
                style = MaterialTheme.typography.title3,
                fontWeight = FontWeight.Bold
            )
            Text(data.message, color = Color.White, style = MaterialTheme.typography.body2)
        }
    }

    Spacer(Modifier.height(8.dp))

    Card(onClick = {}, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(10.dp)) {
            Row("Status", data.status)
            data.expires_at?.let { Row("Expires", it.substring(0, 10)) }
            data.days_until_expiry?.let { Row("Days left", it.toString()) }
            if (data.monthly_price_tsh > 0) {
                Row("Price", "TSh ${data.monthly_price_tsh}/mo")
            }
            data.parent_phone?.let {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Ask parent to renew:",
                    style = MaterialTheme.typography.caption2
                )
                Text(
                    it,
                    color = Color(0xFF00A86B),
                    style = MaterialTheme.typography.body2,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}

@Composable
private fun Row(label: String, value: String) {
    Text("$label: $value", style = MaterialTheme.typography.caption2)
}

package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.layout.Arrangement
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
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.TransactionItem
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class WalletViewModel @Inject constructor(
    val api: ApiService,
    val prefs: PreferencesManager
) : ViewModel()

@Composable
fun WalletScreen(
    navController: NavController,
    vm: WalletViewModel = hiltViewModel()
) {
    val walletBalance by vm.prefs.walletBalance.collectAsStateWithLifecycle(initialValue = 0)
    var transactions by remember { mutableStateOf<List<TransactionItem>>(emptyList()) }

    LaunchedEffect(Unit) {
        try {
            val token = vm.prefs.getAuthToken() ?: return@LaunchedEffect
            val response = vm.api.getWallet("Bearer $token")
            transactions = response.recent_transactions
        } catch (_: Exception) {
        }
    }

    Scaffold(timeText = { TimeText() }) {
        Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
            Card(
                onClick = {},
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        "$walletBalance",
                        style = MaterialTheme.typography.display1,
                        color = Primary
                    )
                    Text("Kobe Points")
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Text("Recent Transactions", style = MaterialTheme.typography.title3)

            LazyColumn {
                items(transactions) { tx ->
                    Card(
                        onClick = {},
                        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(8.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column {
                                Text(tx.description, style = MaterialTheme.typography.body2)
                                Text(tx.type, style = MaterialTheme.typography.caption2)
                            }
                            Text(
                                "+${tx.amount}",
                                color = Primary,
                                style = MaterialTheme.typography.body2
                            )
                        }
                    }
                }
            }
        }
    }
}

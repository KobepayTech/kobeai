package com.kobeai.watch.presentation.screens

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavController
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.kobeai.watch.data.PreferencesManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class BluetoothSetupViewModel @Inject constructor(
    val prefs: PreferencesManager
) : ViewModel()

/**
 * Combined "Bluetooth pairing" tile + first-time-setup wizard.
 *
 * Reachable two ways:
 *   - From HomeScreen: shows current pairing status and a button to open the
 *     system Bluetooth settings (Wear OS handles actual pairing in its
 *     stock UI — re-implementing that on top of the Bluetooth APIs is more
 *     fragile than just deep-linking).
 *   - On first launch (after login, before HomeScreen): walks the kid through
 *     three steps — pair earbuds, pair keyboard, mark setup complete. We
 *     never block them on success of the system settings flow because some
 *     classroom watches have BT pre-paired by the school IT setup.
 */
@Composable
fun BluetoothSetupScreen(
    navController: NavController,
    isWizard: Boolean = false,
    vm: BluetoothSetupViewModel = hiltViewModel()
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(if (isWizard) 0 else -1) }

    fun openBluetoothSettings() {
        try {
            val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (_: Exception) {
            // Fallback to generic settings if the Wear stub doesn't expose
            // the BT-specific deep link on this build of Wear OS.
            try {
                val intent = Intent(Settings.ACTION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            } catch (_: Exception) { /* swallow */ }
        }
    }

    Scaffold(timeText = { TimeText() }) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Top
        ) {
            if (isWizard) {
                Text(
                    text = "Setup ${step + 1} of 3",
                    style = MaterialTheme.typography.caption2,
                    color = MaterialTheme.colors.onSurface.copy(alpha = 0.6f)
                )
                Spacer(Modifier.height(4.dp))
            }
            Text(
                text = when {
                    !isWizard -> "Bluetooth"
                    step == 0 -> "Pair earbuds"
                    step == 1 -> "Pair keyboard"
                    else -> "All set!"
                },
                style = MaterialTheme.typography.title3,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = when {
                    !isWizard -> "Pair your earbuds and keyboard so KobeAI can speak answers and you can type questions."
                    step == 0 -> "Put your earbuds in pairing mode (hold button 3s), then tap Open settings."
                    step == 1 -> "Turn on your keyboard. Tap Open settings to pair it."
                    else -> "Earbuds let KobeAI speak. Keyboard lets you type. You can change these any time."
                },
                style = MaterialTheme.typography.body2,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colors.onSurface.copy(alpha = 0.85f)
            )

            Spacer(Modifier.height(12.dp))

            if (!isWizard || step < 2) {
                Card(
                    onClick = { openBluetoothSettings() },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            "Open settings",
                            style = MaterialTheme.typography.button,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            "Pair via system Bluetooth",
                            style = MaterialTheme.typography.caption2,
                            color = MaterialTheme.colors.onSurface.copy(alpha = 0.6f)
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
            }

            if (isWizard) {
                Button(
                    onClick = {
                        if (step >= 2) {
                            scope.launch {
                                vm.prefs.setSetupCompleted(true)
                                navController.navigate("home") {
                                    popUpTo("setup") { inclusive = true }
                                }
                            }
                        } else {
                            step += 1
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (step >= 2) "Start using KobeAI" else "Skip / Next")
                }
                Spacer(Modifier.height(4.dp))
                if (step < 2) {
                    Text(
                        "You can finish pairing later from the Bluetooth tile.",
                        style = MaterialTheme.typography.caption2,
                        color = MaterialTheme.colors.onSurface.copy(alpha = 0.5f),
                        textAlign = TextAlign.Center
                    )
                }
            } else {
                Button(
                    onClick = { navController.popBackStack() },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Done")
                }
            }
        }
    }
}

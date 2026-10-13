package tz.kobe.k9

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import java.net.URI
import tz.kobe.k9.ui.theme.K9Theme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { K9Theme { K9Home() } }
    }
}

@Composable
private fun K9Home() {
    val context = LocalContext.current
    val preferences = remember { context.getSharedPreferences("k9_school", 0) }
    var savedServer by remember { mutableStateOf(preferences.getString("server", "") ?: "") }
    var server by rememberSaveable { mutableStateOf(savedServer) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedMode by rememberSaveable { mutableStateOf("Exam marking") }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    val modes = listOf("Exam marking", "Teach", "Check work", "Practical", "Capture")

    Scaffold { insets ->
        Column(
            Modifier.fillMaxSize().padding(insets).verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            Text("KobeAI", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Text("K9", style = MaterialTheme.typography.displayLarge)
            Text("Your teaching companion", style = MaterialTheme.typography.headlineSmall)
            Text("Connect your school and glasses, then choose what you want to do.")

            ElevatedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("School server", style = MaterialTheme.typography.titleLarge)
                    Text(if (savedServer.isBlank()) "Not configured" else savedServer)
                    Text(if (savedServer.isBlank()) "Add your school's K9 server address." else "Address saved. Connection and sign-in are not available yet.")
                    TextButton(onClick = { server = savedServer; error = null; showSettings = true }) {
                        Text(if (savedServer.isBlank()) "Set up school" else "Edit address")
                    }
                }
            }
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Teacher glasses", style = MaterialTheme.typography.titleLarge)
                    Text("Not connected")
                    Text("HeyCyan device support is not installed. Pairing and photo capture are unavailable.")
                }
            }
            Text("Choose a mode", style = MaterialTheme.typography.titleLarge)
            modes.forEach { mode ->
                FilterChip(
                    selected = selectedMode == mode,
                    onClick = { selectedMode = mode },
                    label = { Text(mode, Modifier.padding(vertical = 8.dp)) },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(selectedMode, style = MaterialTheme.typography.titleLarge)
                    Text(when (selectedMode) {
                        "Exam marking" -> "Mark papers naturally. The planned glasses workflow captures the question, student's answer, and your marks without reading them aloud."
                        "Teach" -> "Get help from your school's K9 during a lesson."
                        "Check work" -> "Review student work with the school server."
                        "Practical" -> "Capture evidence during practical lessons."
                        else -> "Take a photo using connected teacher glasses."
                    })
                    Text("Sessions require school sign-in and a verified glasses connection. These integrations are still being developed.")
                    Button(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth()) { Text("Start session") }
                }
            }
            Text("Teacher review", style = MaterialTheme.typography.titleLarge)
            Text("No evidence has been captured. Uncertain student identities, answers, and marks must be reviewed before becoming official results.")
        }
    }
    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("School server address") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Use the address provided by your school. No AI provider API key is needed.")
                    OutlinedTextField(
                        value = server, onValueChange = { server = it; error = null },
                        label = { Text("Server URL") }, placeholder = { Text("http://192.168.1.10:8088") },
                        singleLine = true, isError = error != null
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Text("This saves the address only; it does not connect or sign you in.")
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val candidate = server.trim().trimEnd('/')
                    val uri = runCatching { URI(candidate) }.getOrNull()
                    if (uri == null || uri.scheme !in listOf("http", "https") || uri.host.isNullOrBlank() ||
                        uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
                        !uri.path.isNullOrEmpty() || uri.port !in -1..65535 || uri.port == 0) {
                        error = "Enter an HTTP or HTTPS server address, with an optional port and no path or credentials."
                    } else {
                        preferences.edit().putString("server", candidate).apply()
                        savedServer = candidate
                        showSettings = false
                    }
                }) { Text("Save address") }
            },
            dismissButton = { TextButton(onClick = { showSettings = false }) { Text("Cancel") } }
        )
    }
}

package com.kobeai.watch

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.lifecycleScope
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.kobeai.watch.admin.DeviceAdminReceiver
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.presentation.screens.AttendanceScreen
import com.kobeai.watch.presentation.screens.ChatScreen
import com.kobeai.watch.presentation.screens.HomeScreen
import com.kobeai.watch.presentation.screens.LoginScreen
import com.kobeai.watch.presentation.screens.PrintScreen
import com.kobeai.watch.presentation.screens.QuizListScreen
import com.kobeai.watch.presentation.screens.QuizScreen
import com.kobeai.watch.presentation.screens.WalletScreen
import com.kobeai.watch.presentation.theme.KobeAITheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var prefsManager: PreferencesManager

    private lateinit var devicePolicyManager: DevicePolicyManager
    private lateinit var adminComponent: ComponentName

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        devicePolicyManager =
            getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        adminComponent = ComponentName(this, DeviceAdminReceiver::class.java)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enableKioskMode()

        setContent {
            KobeAITheme {
                val navController = rememberNavController()
                val isLoggedIn by prefsManager.isLoggedIn.collectAsState(initial = false)

                NavHost(
                    navController = navController,
                    startDestination = if (isLoggedIn) "home" else "login"
                ) {
                    composable("login") {
                        LoginScreen(
                            onLoginSuccess = {
                                navController.navigate("home") {
                                    popUpTo("login") { inclusive = true }
                                }
                            }
                        )
                    }
                    composable("home") { HomeScreen(navController = navController) }
                    composable("chat") { ChatScreen(navController = navController) }
                    composable("quizzes") { QuizListScreen(navController = navController) }
                    composable("quiz/{quizId}") { backStackEntry ->
                        val quizId = backStackEntry.arguments?.getString("quizId") ?: ""
                        QuizScreen(quizId = quizId, navController = navController)
                    }
                    composable("wallet") { WalletScreen(navController = navController) }
                    composable("attendance") { AttendanceScreen(navController = navController) }
                    composable("print") { PrintScreen(navController = navController) }
                }
            }
        }
    }

    private fun enableKioskMode() {
        try {
            if (devicePolicyManager.isDeviceOwnerApp(packageName)) {
                devicePolicyManager.setLockTaskPackages(adminComponent, arrayOf(packageName))
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    startLockTask()
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_BACK -> true
            else -> super.onKeyDown(keyCode, event)
        }
    }

    override fun onPause() {
        super.onPause()
        lifecycleScope.launch {
            delay(100)
            try {
                startLockTask()
            } catch (_: Exception) {
            }
        }
    }
}

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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.kobeai.watch.admin.DeviceAdminReceiver
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.presentation.screens.AppDetailScreen
import com.kobeai.watch.presentation.screens.AppStoreHomeScreen
import com.kobeai.watch.presentation.screens.AttendanceScreen
import com.kobeai.watch.presentation.screens.InstalledAppsScreen
import com.kobeai.watch.presentation.screens.AdInterstitialScreen
import com.kobeai.watch.presentation.screens.MiniAppRunnerScreen
import com.kobeai.watch.presentation.screens.BluetoothSetupScreen
import com.kobeai.watch.presentation.screens.ChatScreen
import com.kobeai.watch.presentation.screens.HomeScreen
import com.kobeai.watch.presentation.screens.LeaderboardScreen
import com.kobeai.watch.presentation.screens.LoginScreen
import com.kobeai.watch.presentation.screens.PrintScreen
import com.kobeai.watch.presentation.screens.QuizListScreen
import com.kobeai.watch.presentation.screens.QuizScreen
import com.kobeai.watch.presentation.screens.StationeryScreen
import com.kobeai.watch.presentation.screens.SubscriptionScreen
import com.kobeai.watch.presentation.screens.TimetableScreen
import com.kobeai.watch.presentation.screens.ExamCountdownScreen
import com.kobeai.watch.presentation.screens.WalletScreen
import com.kobeai.watch.presentation.theme.KobeAITheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var prefsManager: PreferencesManager
    @Inject lateinit var apiService: ApiService

    private lateinit var devicePolicyManager: DevicePolicyManager
    private lateinit var adminComponent: ComponentName

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        devicePolicyManager =
            getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        adminComponent = ComponentName(this, DeviceAdminReceiver::class.java)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enableImmersiveMode()
        enableKioskMode()

        setContent {
            KobeAITheme {
                val navController = rememberNavController()
                val isLoggedIn by prefsManager.isLoggedIn.collectAsState(initial = false)
                val setupCompleted by prefsManager.setupCompleted.collectAsState(initial = true)

                // Routing rule:
                //   not logged in        -> login
                //   logged in, no setup  -> setup wizard (Bluetooth onboarding)
                //   logged in, setup ok  -> home
                val startDestination = when {
                    !isLoggedIn -> "login"
                    !setupCompleted -> "setup"
                    else -> "home"
                }

                // Background watcher: when the supervisor starts an exam,
                // every student watch flips to the fullscreen countdown
                // automatically. We poll once we know we're logged in and
                // skip if we're already on the exam screen.
                if (isLoggedIn && setupCompleted) {
                    LaunchedEffect(Unit) {
                        while (true) {
                            try {
                                val token = prefsManager.getAuthToken()
                                if (!token.isNullOrBlank()) {
                                    val resp = apiService.getActiveExam("Bearer $token")
                                    val current = navController
                                        .currentBackStackEntry?.destination?.route
                                    if (resp.active && current != "exam") {
                                        navController.navigate("exam") {
                                            popUpTo("home")
                                        }
                                    }
                                }
                            } catch (_: Exception) {}
                            delay(10_000)
                        }
                    }
                }

                NavHost(
                    navController = navController,
                    startDestination = startDestination
                ) {
                    composable("login") {
                        LoginScreen(
                            onLoginSuccess = {
                                // After login, route to setup wizard the first
                                // time so per-student earbuds + keyboard get
                                // paired before the kid hits chat.
                                val target = if (setupCompleted) "home" else "setup"
                                navController.navigate(target) {
                                    popUpTo("login") { inclusive = true }
                                }
                            }
                        )
                    }
                    composable("setup") {
                        BluetoothSetupScreen(navController = navController, isWizard = true)
                    }
                    composable("bluetooth") {
                        BluetoothSetupScreen(navController = navController, isWizard = false)
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
                    composable("subscription") { SubscriptionScreen(navController = navController) }
                    composable("leaderboard") { LeaderboardScreen(navController = navController) }
                    composable("timetable") { TimetableScreen(navController = navController) }
                    composable("exam") { ExamCountdownScreen(navController = navController) }
                    composable("stationery") { StationeryScreen(navController = navController) }
                    composable("store") { AppStoreHomeScreen(navController = navController) }
                    composable("store/installed") { InstalledAppsScreen(navController = navController) }
                    composable("store/app/{appId}") { backStackEntry ->
                        val id = backStackEntry.arguments?.getString("appId")?.toIntOrNull() ?: 0
                        AppDetailScreen(appId = id, navController = navController)
                    }
                    composable("store/run/{appId}") { backStackEntry ->
                        val id = backStackEntry.arguments?.getString("appId")?.toIntOrNull() ?: 0
                        MiniAppRunnerScreen(appId = id, navController = navController)
                    }
                    composable("ads/interstitial/{appId}") { backStackEntry ->
                        val id = backStackEntry.arguments?.getString("appId")?.toIntOrNull() ?: 0
                        AdInterstitialScreen(onDone = {
                            // Replace the interstitial in the back stack with the
                            // mini-app runner so Back doesn't return here.
                            navController.popBackStack()
                            navController.navigate("store/run/$id")
                        })
                    }
                }
            }
        }
    }

    private fun enableKioskMode() {
        try {
            if (devicePolicyManager.isDeviceOwnerApp(packageName)) {
                // Whitelist ourselves so the system allows lock-task pinning.
                devicePolicyManager.setLockTaskPackages(adminComponent, arrayOf(packageName))

                // Strip every system-UI affordance from lock-task mode: no
                // home button, no overview, no notifications, no global
                // actions, no keyguard. The watch becomes a true kiosk.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    try {
                        devicePolicyManager.setLockTaskFeatures(
                            adminComponent,
                            DevicePolicyManager.LOCK_TASK_FEATURE_NONE
                        )
                    } catch (_: Exception) {}
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    startLockTask()
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun enableImmersiveMode() {
        // True immersive — hide status + nav bars; swiping from edges does
        // not reveal them (BEHAVIOR_DEFAULT, not transient-by-swipe). On
        // Wear OS this kills the quick-settings shade pull-down so kids
        // can't open Settings or toggle airplane mode mid-class.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Re-assert immersive mode every time we regain focus — Android
        // sometimes restores the system bars after dialogs/transitions.
        if (hasFocus) enableImmersiveMode()
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

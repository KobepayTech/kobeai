package com.kobeai.watch.presentation.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavController
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.PurchaseRequest
import com.kobeai.watch.data.remote.StoreApp
import com.kobeai.watch.data.remote.StoreCategory
import com.kobeai.watch.presentation.theme.Accent
import com.kobeai.watch.presentation.theme.ErrorRed
import com.kobeai.watch.presentation.theme.MutedText
import com.kobeai.watch.presentation.theme.Primary
import com.kobeai.watch.presentation.theme.PrimaryDark
import com.kobeai.watch.presentation.theme.PrimarySoft
import com.kobeai.watch.presentation.theme.Success
import com.kobeai.watch.presentation.theme.Surface
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

// ===========================================================================
// AppStore Home — featured + categories
// ===========================================================================

@HiltViewModel
class AppStoreHomeViewModel @Inject constructor(
    private val api: ApiService,
    val prefs: PreferencesManager,
) : ViewModel() {
    data class State(
        val loading: Boolean = true,
        val featured: List<StoreApp> = emptyList(),
        val categories: List<StoreCategory> = emptyList(),
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _state.value = State(loading = true)
            try {
                val token = prefs.getAuthToken().orEmpty()
                val resp = api.getStoreFeed("Bearer $token")
                _state.value = State(
                    loading = false,
                    featured = resp.featured,
                    categories = resp.categories,
                )
            } catch (e: Exception) {
                _state.value = State(loading = false, error = e.message ?: "Failed to load")
            }
        }
    }
}

@Composable
fun AppStoreHomeScreen(
    navController: NavController,
    vm: AppStoreHomeViewModel = hiltViewModel(),
) {
    val state by androidx.lifecycle.compose.collectAsStateWithLifecycle(
        vm.state, initialValue = AppStoreHomeViewModel.State()
    )
    val listState = rememberScalingLazyListState()

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            item { StoreHeader() }
            if (state.loading) {
                item { Text("Loading…", color = MutedText) }
            } else if (state.error != null) {
                item { Text(state.error!!, color = ErrorRed) }
                item {
                    Chip(
                        onClick = { vm.load() },
                        label = { Text("Retry") },
                        colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                    )
                }
            } else {
                if (state.featured.isNotEmpty()) {
                    item { SectionLabel("Featured") }
                    items(state.featured) { app ->
                        AppRow(app) { navController.navigate("store/app/${app.id}") }
                    }
                }
                state.categories.forEach { cat ->
                    item { SectionLabel(cat.category.replaceFirstChar { it.uppercase() }) }
                    items(cat.apps) { app ->
                        AppRow(app) { navController.navigate("store/app/${app.id}") }
                    }
                }
                item {
                    Chip(
                        onClick = { navController.navigate("store/installed") },
                        label = { Text("My installed apps") },
                        colors = ChipDefaults.secondaryChipColors(backgroundColor = Surface),
                    )
                }
            }
        }
    }
}

@Composable
private fun StoreHeader() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(
                androidx.compose.ui.graphics.Brush.linearGradient(
                    colors = listOf(Primary, PrimaryDark)
                )
            )
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Column {
            Text("AppStore", color = androidx.compose.ui.graphics.Color.White, fontWeight = FontWeight.Bold)
            Text("Discover mini-apps", color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.caption2)
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        color = MutedText,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 6.dp, start = 4.dp),
    )
}

@Composable
private fun AppRow(app: StoreApp, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = ChipDefaults.secondaryChipColors(backgroundColor = Surface),
        label = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(PrimarySoft),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(app.icon ?: "?", color = androidx.compose.ui.graphics.Color.White)
                }
                Column(modifier = Modifier.padding(start = 8.dp)) {
                    Text(app.name, fontWeight = FontWeight.SemiBold, maxLines = 1)
                    val price = when {
                        app.price_kp > 0 -> "${app.price_kp} KP"
                        app.price_tsh > 0 -> "${app.price_tsh} TSh"
                        else -> "Free"
                    }
                    Text(price, color = if (app.price_kp == 0 && app.price_tsh == 0) Success else Accent, style = MaterialTheme.typography.caption2)
                }
            }
        },
    )
}

// ===========================================================================
// AppDetail — manifest preview, install/purchase, launch
// ===========================================================================

@HiltViewModel
class AppDetailViewModel @Inject constructor(
    private val api: ApiService,
    val prefs: PreferencesManager,
) : ViewModel() {
    data class State(
        val loading: Boolean = true,
        val app: StoreApp? = null,
        val installed: Boolean = false,
        val manifest: Map<String, Any?>? = null,
        val busy: Boolean = false,
        val error: String? = null,
        val message: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var appId: Int = 0

    fun load(id: Int) {
        appId = id
        viewModelScope.launch {
            _state.value = State(loading = true)
            try {
                val token = prefs.getAuthToken().orEmpty()
                val resp = api.getStoreApp("Bearer $token", id)
                _state.value = State(
                    loading = false,
                    app = resp.app,
                    installed = resp.installed,
                    manifest = resp.manifest,
                )
            } catch (e: Exception) {
                _state.value = State(loading = false, error = e.message ?: "Load failed")
            }
        }
    }

    fun install() = act {
        val token = prefs.getAuthToken().orEmpty()
        api.installStoreApp("Bearer $token", appId)
        load(appId)
    }

    fun purchaseKp() = act {
        val token = prefs.getAuthToken().orEmpty()
        api.purchaseStoreApp("Bearer $token", appId, PurchaseRequest("kp"))
        load(appId)
    }

    private fun act(block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, error = null)
            try {
                block()
            } catch (e: Exception) {
                _state.value = _state.value.copy(busy = false, error = e.message ?: "Action failed")
            }
        }
    }
}

@Composable
fun AppDetailScreen(
    appId: Int,
    navController: NavController,
    vm: AppDetailViewModel = hiltViewModel(),
) {
    LaunchedEffect(appId) { vm.load(appId) }
    val state by androidx.lifecycle.compose.collectAsStateWithLifecycle(
        vm.state, initialValue = AppDetailViewModel.State()
    )

    val listState = rememberScalingLazyListState()
    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (state.loading) { item { Text("Loading…", color = MutedText) }; return@ScalingLazyColumn }
            val app = state.app ?: return@ScalingLazyColumn
            item {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    Box(
                        modifier = Modifier.size(46.dp).clip(CircleShape).background(PrimarySoft),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(app.icon ?: "?", color = androidx.compose.ui.graphics.Color.White, fontWeight = FontWeight.Bold)
                    }
                    Text(app.name, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 6.dp))
                    Text(app.category, color = MutedText, style = MaterialTheme.typography.caption2)
                }
            }
            if (!app.description.isNullOrBlank()) {
                item { Text(app.description, color = androidx.compose.ui.graphics.Color.White, style = MaterialTheme.typography.caption1) }
            }
            item {
                val priceText = when {
                    app.price_kp > 0 -> "Price: ${app.price_kp} KP"
                    app.price_tsh > 0 -> "Price: ${app.price_tsh} TSh"
                    else -> "Free"
                }
                Text(priceText, color = Accent, fontWeight = FontWeight.SemiBold)
            }
            if (state.message != null) item { Text(state.message!!, color = Success) }
            if (state.error != null) item { Text(state.error!!, color = ErrorRed) }

            item {
                when {
                    state.installed -> Chip(
                        onClick = { navController.navigate("ads/interstitial/${app.id}") },
                        label = { Text("Open") },
                        colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    state.busy -> Text("Working…", color = MutedText)
                    app.price_kp == 0 && app.price_tsh == 0 -> Chip(
                        onClick = { vm.install() },
                        label = { Text("Install (Free)") },
                        colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    app.price_kp > 0 -> Chip(
                        onClick = { vm.purchaseKp() },
                        label = { Text("Buy ${app.price_kp} KP") },
                        colors = ChipDefaults.primaryChipColors(backgroundColor = Accent),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    else -> Text("TSh purchase via parent app", color = MutedText, style = MaterialTheme.typography.caption2)
                }
            }
        }
    }
}

// ===========================================================================
// Installed list
// ===========================================================================

@HiltViewModel
class InstalledAppsViewModel @Inject constructor(
    private val api: ApiService,
    val prefs: PreferencesManager,
) : ViewModel() {
    data class State(val loading: Boolean = true, val apps: List<StoreApp> = emptyList())
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    init { load() }
    fun load() {
        viewModelScope.launch {
            try {
                val token = prefs.getAuthToken().orEmpty()
                val resp = api.getStoreInstalled("Bearer $token")
                _state.value = State(loading = false, apps = resp.installs.mapNotNull { it.app })
            } catch (_: Exception) {
                _state.value = State(loading = false)
            }
        }
    }
}

@Composable
fun InstalledAppsScreen(
    navController: NavController,
    vm: InstalledAppsViewModel = hiltViewModel(),
) {
    val state by androidx.lifecycle.compose.collectAsStateWithLifecycle(
        vm.state, initialValue = InstalledAppsViewModel.State()
    )
    val listState = rememberScalingLazyListState()
    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            item { Text("Installed", fontWeight = FontWeight.Bold) }
            if (state.loading) item { Text("Loading…", color = MutedText) }
            else if (state.apps.isEmpty()) item { Text("Nothing installed yet.", color = MutedText) }
            else items(state.apps) { app ->
                AppRow(app) { navController.navigate("store/app/${app.id}") }
            }
        }
    }
}

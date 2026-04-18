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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
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
import com.kobeai.watch.data.remote.StationeryDrive
import com.kobeai.watch.data.remote.StationeryItem
import com.kobeai.watch.data.remote.StationeryOrderLine
import com.kobeai.watch.data.remote.StationeryOrderRequest
import com.kobeai.watch.presentation.theme.Accent
import com.kobeai.watch.presentation.theme.ErrorRed
import com.kobeai.watch.presentation.theme.MutedText
import com.kobeai.watch.presentation.theme.Primary
import com.kobeai.watch.presentation.theme.PrimaryDark
import com.kobeai.watch.presentation.theme.Surface
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

// ===========================================================================
// Stationery from the watch
// ===========================================================================
// Flow: student opens Stationery → sees the open drive's catalog → taps + on
// each item to add qty → hits Submit → server creates a `pending_parent_approval`
// order and sends a push to the parent. The watch shows a confirmation with
// the order id + total. Submission is one-shot (no editing) so the watch UI
// stays under 5 taps end-to-end.

@HiltViewModel
class StationeryViewModel @Inject constructor(
    private val api: ApiService,
    val prefs: PreferencesManager,
) : ViewModel() {
    data class State(
        val loading: Boolean = true,
        val drive: StationeryDrive? = null,
        val items: List<StationeryItem> = emptyList(),
        val cart: Map<Int, Int> = emptyMap(),       // item_id -> qty
        val submitting: Boolean = false,
        val submitted: SubmitResult? = null,
        val error: String? = null,
    )
    data class SubmitResult(val orderId: Int, val totalTsh: Int)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _state.value = State(loading = true)
            try {
                val token = prefs.getAuthToken().orEmpty()
                val resp = api.getStationeryDrive("Bearer $token")
                _state.value = State(
                    loading = false,
                    drive = resp.drive,
                    items = resp.items,
                )
            } catch (e: Exception) {
                _state.value = State(loading = false, error = e.message ?: "Failed to load")
            }
        }
    }

    fun bump(itemId: Int, delta: Int) {
        val cur = _state.value.cart.toMutableMap()
        val next = (cur[itemId] ?: 0) + delta
        if (next <= 0) cur.remove(itemId) else cur[itemId] = next
        _state.value = _state.value.copy(cart = cur)
    }

    fun submit() {
        val cart = _state.value.cart
        if (cart.isEmpty() || _state.value.submitting) return
        viewModelScope.launch {
            _state.value = _state.value.copy(submitting = true, error = null)
            try {
                val token = prefs.getAuthToken().orEmpty()
                val lines = cart.map { (id, qty) -> StationeryOrderLine(item_id = id, qty = qty) }
                val resp = api.submitStationeryOrder("Bearer $token", StationeryOrderRequest(lines))
                _state.value = _state.value.copy(
                    submitting = false,
                    submitted = SubmitResult(orderId = resp.order_id, totalTsh = resp.total_tsh),
                    cart = emptyMap(),
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    submitting = false,
                    error = e.message ?: "Submit failed",
                )
            }
        }
    }
}

@Composable
fun StationeryScreen(
    navController: NavController,
    vm: StationeryViewModel = hiltViewModel(),
) {
    val state by androidx.lifecycle.compose.collectAsStateWithLifecycle(
        vm.state, initialValue = StationeryViewModel.State()
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
            item { StationeryHeader(state.drive) }

            when {
                state.loading -> item { Text("Loading…", color = MutedText) }
                state.error != null -> {
                    item { Text(state.error!!, color = ErrorRed) }
                    item {
                        Chip(
                            onClick = { vm.load() },
                            label = { Text("Retry") },
                            colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                        )
                    }
                }
                state.submitted != null -> {
                    item { SubmittedCard(state.submitted!!) }
                    item {
                        Chip(
                            onClick = { navController.popBackStack() },
                            label = { Text("Done") },
                            colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                        )
                    }
                }
                state.drive == null -> {
                    item {
                        Text(
                            "No stationery drive open right now.",
                            color = MutedText,
                        )
                    }
                }
                state.items.isEmpty() -> {
                    item { Text("Catalog is empty.", color = MutedText) }
                }
                else -> {
                    items(state.items) { item ->
                        ItemRow(
                            item = item,
                            qty = state.cart[item.id] ?: 0,
                            onPlus = { vm.bump(item.id, +1) },
                            onMinus = { vm.bump(item.id, -1) },
                        )
                    }
                    item { CartTotal(state.items, state.cart) }
                    item {
                        Chip(
                            onClick = { vm.submit() },
                            enabled = state.cart.isNotEmpty() && !state.submitting,
                            label = {
                                Text(if (state.submitting) "Sending…" else "Send to parent")
                            },
                            colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                        )
                    }
                    item {
                        Text(
                            "Your parent will approve from the KobeAI app.",
                            color = MutedText,
                            style = MaterialTheme.typography.caption2,
                            modifier = Modifier.padding(horizontal = 6.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StationeryHeader(drive: StationeryDrive?) {
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
            Text("Stationery", color = Color.White, fontWeight = FontWeight.Bold)
            Text(
                drive?.title ?: "No open drive",
                color = Color.White.copy(alpha = 0.8f),
                style = MaterialTheme.typography.caption2,
            )
        }
    }
}

@Composable
private fun ItemRow(
    item: StationeryItem,
    qty: Int,
    onPlus: () -> Unit,
    onMinus: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Surface)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(item.name, fontWeight = FontWeight.SemiBold)
            Text(
                "TSh ${item.price_tsh.toLocaleString()}${item.unit?.let { " / $it" } ?: ""}",
                color = MutedText,
                style = MaterialTheme.typography.caption2,
            )
        }
        QtyPill(qty = qty, onPlus = onPlus, onMinus = onMinus)
    }
}

@Composable
private fun QtyPill(qty: Int, onPlus: () -> Unit, onMinus: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (qty > 0) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Accent.copy(alpha = 0.25f))
                    .clickable(onClick = onMinus),
                contentAlignment = Alignment.Center,
            ) { Text("–", fontWeight = FontWeight.Bold) }
            Text(
                qty.toString(),
                modifier = Modifier.padding(horizontal = 6.dp),
                fontWeight = FontWeight.Bold,
            )
        }
        Box(
            modifier = Modifier
                .size(24.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Primary)
                .clickable(onClick = onPlus),
            contentAlignment = Alignment.Center,
        ) { Text("+", color = Color.White, fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun CartTotal(items: List<StationeryItem>, cart: Map<Int, Int>) {
    val total = remember(cart, items) {
        cart.entries.sumOf { (id, qty) ->
            (items.find { it.id == id }?.price_tsh ?: 0) * qty
        }
    }
    val count = cart.values.sum()
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Accent.copy(alpha = 0.15f))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Column {
            Text("Cart total", color = MutedText, style = MaterialTheme.typography.caption2)
            Text(
                "TSh ${total.toLocaleString()}  •  $count items",
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun SubmittedCard(result: StationeryViewModel.SubmitResult) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Primary)
            .padding(horizontal = 12.dp, vertical = 12.dp),
    ) {
        Column {
            Text("Sent to parent", color = Color.White, fontWeight = FontWeight.Bold)
            Text(
                "Order #${result.orderId}  •  TSh ${result.totalTsh.toLocaleString()}",
                color = Color.White.copy(alpha = 0.85f),
                style = MaterialTheme.typography.caption2,
            )
            Text(
                "They'll get a notification to approve.",
                color = Color.White.copy(alpha = 0.85f),
                style = MaterialTheme.typography.caption2,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

// Tiny extension so we don't pull java.text.NumberFormat just for thousands.
private fun Int.toLocaleString(): String =
    this.toString().reversed().chunked(3).joinToString(",").reversed()

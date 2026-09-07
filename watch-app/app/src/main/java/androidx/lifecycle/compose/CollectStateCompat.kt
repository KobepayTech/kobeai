package androidx.lifecycle.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import kotlinx.coroutines.flow.StateFlow

/**
 * Source-compatibility bridge for screens that were authored against a
 * top-level collectAsStateWithLifecycle call. The tablet migration will move
 * those screens to the normal StateFlow extension while preserving the same
 * state behavior in the interim.
 */
@Composable
fun <T> collectAsStateWithLifecycle(
    flow: StateFlow<T>,
    initialValue: T,
): State<T> = flow.collectAsState(initial = initialValue)

package com.kobeai.watch.presentation.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.kobeai.watch.data.remote.AdEventRequest
import com.kobeai.watch.data.remote.AdPayload
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.presentation.theme.Accent
import com.kobeai.watch.presentation.theme.MutedText
import com.kobeai.watch.presentation.theme.Navy
import com.kobeai.watch.presentation.theme.Primary
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel that fetches and tracks a single ad. Shared between the home tile
 * (banner format) and the mini-app interstitial (interstitial format).
 */
@HiltViewModel
class AdViewModel @Inject constructor(private val api: ApiService) : ViewModel() {
    var ad by mutableStateOf<AdPayload?>(null)
        private set
    var loaded by mutableStateOf(false)
        private set
    private var impressionTracked = false

    fun load(placement: String) {
        if (loaded) return
        loaded = true
        viewModelScope.launch {
            try {
                val res = api.getAd(placement)
                ad = res.ad
                ad?.let {
                    if (!impressionTracked) {
                        impressionTracked = true
                        runCatching {
                            api.postAdEvent(AdEventRequest(it.impression_token, "impression"))
                        }
                    }
                }
            } catch (_: Throwable) {
                ad = null
            }
        }
    }

    fun trackClick(token: String) {
        viewModelScope.launch {
            runCatching { api.postAdEvent(AdEventRequest(token, "click")) }
        }
    }
}

/**
 * Compact tile shown inline on the watch home menu. Returns nothing if no
 * ad is currently being served.
 */
@Composable
fun AdHomeTile(
    placement: String = "watch_home_tile",
    vm: AdViewModel = hiltViewModel(),
) {
    LaunchedEffect(placement) { vm.load(placement) }
    val ad = vm.ad ?: return
    val context = LocalContext.current

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Navy)
            .clickable {
                vm.trackClick(ad.impression_token)
                runCatching {
                    context.startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse(ad.creative.cta_url))
                    )
                }
            }
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Column {
            Text(
                text = "Sponsored",
                color = Accent,
                style = MaterialTheme.typography.caption3,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = ad.creative.title,
                color = Color.White,
                style = MaterialTheme.typography.caption1,
                fontWeight = FontWeight.SemiBold,
            )
            ad.creative.body?.let {
                Text(
                    text = it,
                    color = Color.White.copy(alpha = 0.7f),
                    style = MaterialTheme.typography.caption3,
                )
            }
            Text(
                text = "${ad.creative.cta_label ?: "Learn more"} →",
                color = Primary,
                style = MaterialTheme.typography.caption3,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

/**
 * Fullscreen interstitial shown briefly between mini-app launches. The user
 * taps "Skip" to dismiss or the CTA to open the advertiser landing page.
 */
@Composable
fun AdInterstitialScreen(
    placement: String = "watch_miniapp_interstitial",
    onDone: () -> Unit,
    vm: AdViewModel = hiltViewModel(),
) {
    LaunchedEffect(placement) { vm.load(placement) }
    val ad = vm.ad
    val context = LocalContext.current

    // No ad available: skip immediately.
    LaunchedEffect(vm.loaded, ad) {
        if (vm.loaded && ad == null) onDone()
    }

    Scaffold(timeText = { TimeText() }) {
        if (ad == null) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Loading…", color = MutedText)
            }
            return@Scaffold
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "Sponsored",
                color = Accent,
                style = MaterialTheme.typography.caption2,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = ad.creative.title,
                color = Color.White,
                style = MaterialTheme.typography.title3,
                fontWeight = FontWeight.Bold,
            )
            ad.creative.body?.let {
                Text(
                    text = it,
                    color = MutedText,
                    style = MaterialTheme.typography.caption1,
                )
            }
            Chip(
                onClick = {
                    vm.trackClick(ad.impression_token)
                    runCatching {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse(ad.creative.cta_url))
                        )
                    }
                    onDone()
                },
                label = { Text(ad.creative.cta_label ?: "Learn more") },
                colors = ChipDefaults.primaryChipColors(backgroundColor = Primary),
                modifier = Modifier.fillMaxWidth(),
            )
            Chip(
                onClick = onDone,
                label = { Text("Skip") },
                colors = ChipDefaults.secondaryChipColors(),
            )
        }
    }
}

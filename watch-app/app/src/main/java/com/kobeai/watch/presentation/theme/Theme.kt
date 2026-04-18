package com.kobeai.watch.presentation.theme

import androidx.compose.runtime.Composable
import androidx.wear.compose.material.MaterialTheme

@Composable
fun KobeAITheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colors = MaterialTheme.colors.copy(
            primary = Primary,
            primaryVariant = PrimaryDark,
            secondary = Accent,
            secondaryVariant = Accent,
            background = Background,
            surface = Surface,
            error = ErrorRed,
            onPrimary = OnSurface,
            onSecondary = Navy,
            onBackground = OnSurface,
            onSurface = OnSurface,
            onSurfaceVariant = OnSurfaceMuted,
            onError = OnSurface
        ),
        typography = KobeAITypography,
        content = content
    )
}

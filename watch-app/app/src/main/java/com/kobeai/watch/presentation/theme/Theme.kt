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
            background = Background,
            surface = Surface,
            error = ErrorRed,
            onPrimary = OnSurface,
            onSurface = OnSurface
        ),
        typography = KobeAITypography,
        content = content
    )
}

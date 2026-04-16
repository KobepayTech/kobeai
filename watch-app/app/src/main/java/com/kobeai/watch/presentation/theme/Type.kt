package com.kobeai.watch.presentation.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Typography

val KobeAITypography = Typography(
    title1 = TextStyle(fontWeight = FontWeight.Bold, fontSize = 24.sp),
    title2 = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
    title3 = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    body1 = TextStyle(fontWeight = FontWeight.Normal, fontSize = 16.sp),
    body2 = TextStyle(fontWeight = FontWeight.Normal, fontSize = 14.sp),
    button = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    caption1 = TextStyle(fontWeight = FontWeight.Normal, fontSize = 12.sp),
    caption2 = TextStyle(fontWeight = FontWeight.Normal, fontSize = 11.sp)
)

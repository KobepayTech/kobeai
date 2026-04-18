package com.kobeai.watch.data

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Wraps Android's TextToSpeech engine for the watch chat reply pipeline.
 *
 * Wear OS routes all audio to the active BT output (paired earbuds), so we do
 * not have to manage audio routing ourselves. We lazily init the engine on
 * first use to avoid the ~400ms warm-up cost on cold boot when the kid never
 * actually opens chat.
 *
 * Language strategy: try Swahili (sw_TZ) first, fall back to English (en_US).
 * If neither pack is installed on the device, `speak` becomes a no-op rather
 * than crashing — the visual reply on screen still shows.
 */
@Singleton
class TtsManager @Inject constructor(
    @ApplicationContext private val context: Context
) {
    private var tts: TextToSpeech? = null
    private var ready = false
    // Pending callbacks to fire once init completes. Prevents the "second
    // message dropped during cold init" race where ensureInit returned early
    // because tts was non-null but not yet ready.
    private val pending = mutableListOf<() -> Unit>()

    @Synchronized
    private fun ensureInit(onReady: () -> Unit) {
        if (ready) {
            onReady()
            return
        }
        if (tts != null) {
            pending.add(onReady)
            return
        }
        pending.add(onReady)
        tts = TextToSpeech(context.applicationContext) { status ->
            val toFire: List<() -> Unit>
            synchronized(this) {
                if (status == TextToSpeech.SUCCESS) {
                    val sw = tts?.isLanguageAvailable(Locale("sw", "TZ"))
                        ?: TextToSpeech.LANG_NOT_SUPPORTED
                    if (sw >= TextToSpeech.LANG_AVAILABLE) {
                        tts?.language = Locale("sw", "TZ")
                    } else {
                        tts?.language = Locale.US
                    }
                    tts?.setSpeechRate(0.95f)
                    tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(id: String?) {}
                        override fun onDone(id: String?) {}
                        @Deprecated("legacy")
                        override fun onError(id: String?) {}
                    })
                    ready = true
                    toFire = pending.toList()
                    pending.clear()
                } else {
                    tts = null
                    toFire = emptyList()
                    pending.clear()
                }
            }
            toFire.forEach { runCatching { it() } }
        }
    }

    /**
     * Speak the AI reply on the active audio output. Re-entrant: a new call
     * interrupts any in-flight utterance so back-to-back replies do not stack.
     */
    fun speak(text: String) {
        if (text.isBlank()) return
        val utteranceId = "kobe-${System.currentTimeMillis()}"
        ensureInit {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        }
    }

    fun stop() {
        try { tts?.stop() } catch (_: Exception) {}
    }

    fun shutdown() {
        try { tts?.shutdown() } catch (_: Exception) {}
        tts = null
        ready = false
    }
}

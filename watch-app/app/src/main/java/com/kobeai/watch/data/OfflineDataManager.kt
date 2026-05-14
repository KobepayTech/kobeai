package com.kobeai.watch.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.kobeai.watch.data.remote.ApiService
import com.kobeai.watch.data.remote.OfflineQuestion
import com.kobeai.watch.data.remote.QuestionRequest
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class OfflineDataManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val apiService: ApiService,
    private val prefsManager: PreferencesManager
) {
    private val dataStore = context.dataStore
    private val gson = Gson()
    private val queueKey = stringPreferencesKey("offline_queue")

    private val preloadedAnswers = mapOf(
        "photosynthesis" to "Photosynthesis is the process plants use to convert sunlight into energy.",
        "2+2" to "2 + 2 = 4",
        "capital of tanzania" to "Dodoma is the capital city of Tanzania.",
        "kilimanjaro" to "Mount Kilimanjaro is the tallest mountain in Africa at 5,895 meters."
    )

    fun getOfflineAnswer(question: String): String? {
        val normalized = question.lowercase().trim()
        preloadedAnswers[normalized]?.let { return it }
        preloadedAnswers.entries.find { normalized.contains(it.key) }?.let { return it.value }
        return null
    }

    suspend fun queueQuestion(question: String, subject: String?) {
        val offline = OfflineQuestion(
            id = java.util.UUID.randomUUID().toString(),
            question = question,
            subject = subject,
            timestamp = System.currentTimeMillis()
        )
        val queue = getQueue().toMutableList()
        queue.add(offline)
        // Cap the queue so a long offline period doesn't fill watch storage.
        // Drop oldest entries first — recent questions are likelier to still
        // matter to the student when connectivity returns.
        val trimmed = if (queue.size > MAX_QUEUE_SIZE) {
            queue.takeLast(MAX_QUEUE_SIZE)
        } else queue
        saveQueue(trimmed)
    }

    suspend fun getPendingCount(): Int = getQueue().size

    suspend fun processSyncQueue(token: String) {
        val queue = getQueue()
        if (queue.isEmpty()) return

        val processed = mutableListOf<OfflineQuestion>()
        queue.forEach { q ->
            try {
                apiService.askQuestion(token, QuestionRequest(q.question, q.subject))
                processed.add(q)
            } catch (_: Exception) {
                // Keep in queue
            }
        }

        val remaining = queue.filterNot { processed.contains(it) }
        saveQueue(remaining)
    }

    private suspend fun getQueue(): List<OfflineQuestion> {
        val json = dataStore.data.map { it[queueKey] }.first()
        return if (json != null) {
            try {
                val type = object : TypeToken<List<OfflineQuestion>>() {}.type
                gson.fromJson(json, type)
            } catch (_: Exception) {
                emptyList()
            }
        } else emptyList()
    }

    private suspend fun saveQueue(queue: List<OfflineQuestion>) {
        dataStore.edit { it[queueKey] = gson.toJson(queue) }
    }

    companion object {
        private const val MAX_QUEUE_SIZE = 100
    }
}

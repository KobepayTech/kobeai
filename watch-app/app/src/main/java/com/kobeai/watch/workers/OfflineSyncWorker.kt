package com.kobeai.watch.workers

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.kobeai.watch.data.OfflineDataManager
import com.kobeai.watch.data.PreferencesManager
import com.kobeai.watch.data.remote.ApiService
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import timber.log.Timber

@HiltWorker
class OfflineSyncWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val apiService: ApiService,
    private val offlineDataManager: OfflineDataManager,
    private val prefsManager: PreferencesManager
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        return try {
            Timber.d("Starting offline sync")
            val token = prefsManager.getAuthToken()
            if (token.isNullOrEmpty()) return Result.retry()

            val pendingCount = offlineDataManager.getPendingCount()
            if (pendingCount > 0) {
                offlineDataManager.processSyncQueue("Bearer $token")
                Timber.d("Synced $pendingCount items")
            }
            Result.success()
        } catch (e: Exception) {
            Timber.e(e, "Sync failed")
            Result.retry()
        }
    }
}

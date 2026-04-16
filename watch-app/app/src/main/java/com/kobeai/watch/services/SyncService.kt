package com.kobeai.watch.services

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.kobeai.watch.workers.OfflineSyncWorker
import java.util.concurrent.TimeUnit

class SyncService : Service() {

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForeground(
            1,
            NotificationCompat.Builder(this, "kobeai_sync")
                .setContentTitle("KobeAI")
                .setContentText("Sync service running")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .build()
        )
        schedulePeriodicSync()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "kobeai_sync",
                "KobeAI Sync",
                NotificationManager.IMPORTANCE_LOW
            )
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
    override fun onBind(intent: Intent?): IBinder? = null

    private fun schedulePeriodicSync() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val syncRequest = PeriodicWorkRequestBuilder<OfflineSyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "kobeai_sync",
            ExistingPeriodicWorkPolicy.KEEP,
            syncRequest
        )
    }

    companion object {
        fun startService(context: Context) {
            context.startService(Intent(context, SyncService::class.java))
        }
    }
}

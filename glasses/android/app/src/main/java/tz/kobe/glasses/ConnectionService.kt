package tz.kobe.glasses

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/** Keeps the current Activity-owned Rokid SDK session eligible while minimised.
 * The SDK requires an Activity: process death/task removal is not a headless boot flow.
 */
class ConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("rokid-connection", "Rokid connection", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction("stop"), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, "rokid-connection")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setContentTitle("KobeAI · Rokid connection")
            .setContentText("Connection active; retries automatically if interrupted. No background capture.")
            .setContentIntent(open).setOngoing(true).addAction(android.R.drawable.ic_media_pause, "Pause", stop).build()
        startForeground(9109, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") { RokidCredentials.enable(this, false); stopSelf() }
        return START_NOT_STICKY
    }
    override fun onTaskRemoved(rootIntent: Intent?) { stopSelf() }
    override fun onDestroy() { onStopped?.invoke(); super.onDestroy() }
    companion object { var onStopped: (() -> Unit)? = null }
}

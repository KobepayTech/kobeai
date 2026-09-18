package tz.kobe.glasses

import android.bluetooth.BluetoothDevice
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.oudmon.ble.base.bluetooth.BleAction
import com.oudmon.ble.base.bluetooth.BleBaseControl
import com.oudmon.ble.base.bluetooth.BleOperateManager
import com.oudmon.ble.base.bluetooth.QCBluetoothCallbackCloneReceiver
import com.oudmon.ble.base.communication.LargeDataHandler
import com.oudmon.ble.base.communication.bigData.resp.GlassesDeviceNotifyListener
import com.oudmon.ble.base.communication.bigData.resp.GlassesDeviceNotifyRsp
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

/** Bindings to the vendor AAR, based on its sample + Chinese development guide.
 * Capture requests a fresh AI thumbnail and waits for JPEG bytes, not just a
 * successful shutter command. No vendor cloud or invented live-video API.
 */
class HeyCyanHardware(private val activity: MainActivity, private val address: String,
                      private val onLost: () -> Unit) : Hardware {
    private var connected = false
    private var registered = false
    private var closed = false
    private var ready = CompletableDeferred<Unit>()
    private var photo: CompletableDeferred<ByteArray>? = null
    private val receiver = object : QCBluetoothCallbackCloneReceiver() {
        override fun connectStatue(device: BluetoothDevice?, connected: Boolean) {
            if (!connected && !closed) {
                this@HeyCyanHardware.connected = false
                ready.completeExceptionally(IllegalStateException("Bluetooth disconnected"))
                photo?.completeExceptionally(IllegalStateException("Bluetooth disconnected"))
                onLost()
            }
        }
        override fun onServiceDiscovered() {
            if (closed) return
            LargeDataHandler.getInstance().initEnable()
            BleOperateManager.getInstance().isReady = true
            connected = true
            ready.complete(Unit)
        }
        override fun onCharacteristicChange(address: String?, uuid: String?, data: ByteArray?) {}
        override fun onCharacteristicRead(uuid: String?, data: ByteArray?) {}
    }
    private val listener = object : GlassesDeviceNotifyListener() {
        override fun parseData(cmdType: Int, response: GlassesDeviceNotifyRsp) {
            val data = response.loadData ?: return
            // Ignore unsolicited images: upload only after an explicit Lens shutter.
            val pending = photo ?: return
            if (closed || data.size < 7 || data[6].toInt() != 0x02 || pending.isCompleted) return
            LargeDataHandler.getInstance().getPictureThumbnails { _, success, bytes ->
                if (photo !== pending || closed || pending.isCompleted) return@getPictureThumbnails
                if (success && bytes != null && bytes.size in 3..8_000_000 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte()) pending.complete(bytes)
                else pending.completeExceptionally(IllegalStateException("Thumbnail transfer failed"))
            }
        }
    }
    override suspend fun connect() {
        check(!closed)
        BleOperateManager.getInstance(activity.application).apply { setApplication(activity.application); init() }
        BleBaseControl.getInstance(activity.applicationContext).setmContext(activity.application)
        LocalBroadcastManager.getInstance(activity).registerReceiver(receiver, BleAction.getIntentFilter())
        registered = true
        LargeDataHandler.getInstance().addOutDeviceListener(LISTENER_ID, listener)
        BleOperateManager.getInstance().setBluetoothTurnOff(true)
        BleOperateManager.getInstance().connectDirectly(address)
        withTimeout(30_000) { ready.await() }
    }
    override suspend fun capture(): ByteArray {
        check(connected && !closed) { "Glasses disconnected" }
        check(photo == null) { "Capture already in progress" }
        val pending = CompletableDeferred<ByteArray>(); photo = pending
        try {
            // Exact AI-thumbnail command used by the vendor sample (size index 2).
            LargeDataHandler.getInstance().glassesControl(byteArrayOf(0x02, 0x01, 0x06, 0x02, 0x02, 0x02)) { _, _ ->
                // Acceptance is not capture completion. Wait for notify + JPEG.
            }
            return withTimeout(25_000) { pending.await() }
        } finally { if (photo === pending) photo = null }
    }
    override suspend fun disconnect() {
        if (closed) return
        closed = true; connected = false
        photo?.cancel(); photo = null; ready.cancel()
        LargeDataHandler.getInstance().removeOutDeviceListener(LISTENER_ID)
        if (registered) LocalBroadcastManager.getInstance(activity).unregisterReceiver(receiver)
        registered = false
        BleOperateManager.getInstance().setBluetoothTurnOff(false)
        BleOperateManager.getInstance().disconnect()
    }
    override suspend fun display(text: String): Unit = error("These glasses have no supported display")
    override suspend fun speak(text: String): Unit = error("Use the phone's paired Bluetooth audio output")
    override fun capabilities() = JSONObject().put("camera", true)
    companion object { private const val LISTENER_ID = 9109 }
}

package tz.kobe.glasses

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Independent gateway-to-gateway BLE GATT transport. NOT a MoYoung glasses
 * protocol. Does not scan or auto-connect to strangers: central connections
 * require an administrator-provisioned bonded peer MAC.
 *
 * Frames are opaque to this radio driver; K9GatewayMeshBridge performs framing
 * and K9SchoolMeshCrypto authenticates/decrypts them. No student data in frames.
 * This is a hardware integration component; app/service wiring is separate.
 *
 * Caller must request BLUETOOTH_CONNECT and BLUETOOTH_ADVERTISE permissions.
 */
@SuppressLint("MissingPermission")
class K9GatewayGattLink(
    private val context: Context,
    private val onFrame: (peerAddress: String, bytes: ByteArray) -> Unit,
    private val onConnection: (peerAddress: String, connected: Boolean) -> Unit,
) {
    companion object {
        val SERVICE_UUID: UUID = UUID.fromString("d2e2d731-81b5-4b7a-b0db-65f3907b70aa")
        val FRAME_UUID: UUID = UUID.fromString("d2e2d732-81b5-4b7a-b0db-65f3907b70aa")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val TAG = "K9GatewayGatt"
        private const val MAX_GATT_VALUE = 244
    }
    private val manager = context.getSystemService(BluetoothManager::class.java)
    private val adapter: BluetoothAdapter get() = manager.adapter
    private var server: BluetoothGattServer? = null
    private var advertising = false
    private val clients = ConcurrentHashMap<String, BluetoothGatt>()
    private val subscribed = ConcurrentHashMap.newKeySet<String>()
    private val allowedAddresses = ConcurrentHashMap.newKeySet<String>()
    private val mtuPayload = ConcurrentHashMap<String, Int>()
    private val pendingAcks = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()
    private val sendGate = Mutex()
    private val advertiserCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) {
            advertising = false
            Log.w(TAG, "Gateway BLE advertisement failed: $errorCode")
        }
    }
    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            val connected = status == BluetoothGatt.GATT_SUCCESS &&
                newState == BluetoothProfile.STATE_CONNECTED
            if (!connected) subscribed.remove(device.address)
            if (!allowedAddresses.contains(device.address) && connected) {
                server?.cancelConnection(device)
                return
            }
            onConnection(device.address, connected)
        }
        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            mtuPayload[device.address] = (mtu - 3).coerceIn(20, MAX_GATT_VALUE)
        }
        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            pendingAcks.remove(device.address)?.complete(status == BluetoothGatt.GATT_SUCCESS)
        }
        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray,
        ) {
            val permitted = allowedAddresses.contains(device.address) &&
                characteristic.uuid == FRAME_UUID && !preparedWrite &&
                offset == 0 && value.isNotEmpty() && value.size <= MAX_GATT_VALUE
            if (responseNeeded) server?.sendResponse(device, requestId,
                if (permitted) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE,
                0, null)
            if (permitted) onFrame(device.address, value.copyOf())
        }
        override fun onDescriptorWriteRequest(
            device: BluetoothDevice, requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray,
        ) {
            val permitted = allowedAddresses.contains(device.address) &&
                descriptor.uuid == CCCD_UUID && !preparedWrite && offset == 0 &&
                (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ||
                 value.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE))
            if (permitted) {
                if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE))
                    subscribed.add(device.address)
                else subscribed.remove(device.address)
            }
            if (responseNeeded) server?.sendResponse(device, requestId,
                if (permitted) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE,
                0, null)
        }
    }
    private val clientCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                gatt.requestMtu(247)
                onConnection(gatt.device.address, true)
            } else {
                clients.remove(gatt.device.address)
                onConnection(gatt.device.address, false)
                gatt.close()
            }
        }
        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            mtuPayload[gatt.device.address] =
                if (status == BluetoothGatt.GATT_SUCCESS) (mtu - 3).coerceIn(20, MAX_GATT_VALUE) else 20
            gatt.discoverServices()
        }
        override fun onCharacteristicWrite(
            gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int,
        ) {
            if (characteristic.uuid == FRAME_UUID)
                pendingAcks.remove(gatt.device.address)?.complete(status == BluetoothGatt.GATT_SUCCESS)
        }
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) return
            val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(FRAME_UUID)
                ?: return
            gatt.setCharacteristicNotification(characteristic, true)
            val descriptor = characteristic.getDescriptor(CCCD_UUID) ?: return
            if (Build.VERSION.SDK_INT >= 33)
                gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            else {
                @Suppress("DEPRECATION")
                descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                gatt.writeDescriptor(descriptor)
            }
        }
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic,
        ) {
            onCharacteristicChanged(gatt, characteristic, characteristic.value ?: return)
        }
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray,
        ) {
            if (characteristic.uuid == FRAME_UUID && allowedAddresses.contains(gatt.device.address))
                onFrame(gatt.device.address, value.copyOf())
        }
    }
    /**
     * Explicit provisioning. MAC address alone is not a cryptographic identity.
     * The mesh layer must verify the school key and peer enrollment too.
     */
    fun provisionBondedPeer(device: BluetoothDevice) {
        require(device.bondState == BluetoothDevice.BOND_BONDED) { "Bond peer first" }
        allowedAddresses.add(device.address)
    }
    fun revokePeer(address: String) {
        allowedAddresses.remove(address)
        subscribed.remove(address)
        pendingAcks.remove(address)?.complete(false)
        mtuPayload.remove(address)
        clients.remove(address)?.disconnect()
    }
    fun startPeripheral() {
        check(adapter.isEnabled) { "Enable Bluetooth" }
        check(adapter.isMultipleAdvertisementSupported) { "BLE peripheral advertising unavailable" }
        if (server != null) return
        val characteristic = BluetoothGattCharacteristic(
            FRAME_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED,
        )
        characteristic.addDescriptor(BluetoothGattDescriptor(
            CCCD_UUID, BluetoothGattDescriptor.PERMISSION_WRITE_ENCRYPTED))
        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(characteristic)
        server = manager.openGattServer(context, serverCallback)
            ?: error("Cannot open K9 BLE GATT server")
        check(server!!.addService(service)) { "Cannot register K9 BLE service" }
        val advertiser = adapter.bluetoothLeAdvertiser ?: error("BLE advertiser unavailable")
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true).build()
        val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE_UUID))
            .setIncludeDeviceName(false).build()
        advertiser.startAdvertising(settings, data, advertiserCallback)
        advertising = true
    }
    fun connectBondedPeer(device: BluetoothDevice) {
        check(allowedAddresses.contains(device.address)) { "Peer not provisioned" }
        check(device.bondState == BluetoothDevice.BOND_BONDED) { "Peer bond revoked" }
        if (clients.containsKey(device.address)) return
        val gatt = device.connectGatt(context, false, clientCallback, BluetoothDevice.TRANSPORT_LE)
        clients[device.address] = gatt
    }
    /** Maximum usable ATT value bytes for the current negotiated MTU. */
    fun payloadSize(address: String): Int = mtuPayload[address] ?: 20

    /**
     * Send one frame with serialized GATT write/notification completion.
     * This is link-level acknowledgement only, NOT end-to-end mesh delivery.
     * Callers must send successive frames one at a time.
     */
    suspend fun sendFrame(address: String, bytes: ByteArray): Boolean = sendGate.withLock {
        if (bytes.isEmpty() || bytes.size > payloadSize(address) ||
            !allowedAddresses.contains(address)) return@withLock false
        val ack = CompletableDeferred<Boolean>()
        pendingAcks[address] = ack
        val initiated = writeFrame(address, bytes) || notifyFrame(address, bytes)
        if (!initiated) {
            pendingAcks.remove(address)
            return@withLock false
        }
        val result = withTimeoutOrNull(10_000) { ack.await() } ?: false
        pendingAcks.remove(address)
        result
    }

    private fun notifyFrame(address: String, bytes: ByteArray): Boolean {
        if (!subscribed.contains(address)) return false
        val device = adapter.getRemoteDevice(address)
        val characteristic = server?.getService(SERVICE_UUID)?.getCharacteristic(FRAME_UUID)
            ?: return false
        return if (Build.VERSION.SDK_INT >= 33)
            server?.notifyCharacteristicChanged(device, characteristic, false, bytes) ==
                android.bluetooth.BluetoothStatusCodes.SUCCESS
        else {
            @Suppress("DEPRECATION")
            characteristic.value = bytes
            @Suppress("DEPRECATION")
            server?.notifyCharacteristicChanged(device, characteristic, false) == true
        }
    }

    private fun writeFrame(address: String, bytes: ByteArray): Boolean {
        if (bytes.isEmpty() || bytes.size > MAX_GATT_VALUE) return false
        if (!allowedAddresses.contains(address)) return false
        val gatt = clients[address] ?: return false
        val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(FRAME_UUID)
            ?: return false
        return if (Build.VERSION.SDK_INT >= 33)
            gatt.writeCharacteristic(characteristic, bytes,
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) ==
                android.bluetooth.BluetoothStatusCodes.SUCCESS
        else {
            @Suppress("DEPRECATION")
            characteristic.value = bytes
            @Suppress("DEPRECATION")
            gatt.writeCharacteristic(characteristic)
        }
    }
    fun stop() {
        clients.values.forEach { it.disconnect(); it.close() }
        clients.clear()
        pendingAcks.values.forEach { it.complete(false) }
        pendingAcks.clear()
        mtuPayload.clear()
        subscribed.clear()
        if (advertising) {
            adapter.bluetoothLeAdvertiser?.stopAdvertising(advertiserCallback)
            advertising = false
        }
        server?.close()
        server = null
    }
}

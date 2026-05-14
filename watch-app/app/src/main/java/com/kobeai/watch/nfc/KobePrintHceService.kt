package com.kobeai.watch.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import com.kobeai.watch.BuildConfig
import com.kobeai.watch.data.PreferencesManager
import dagger.hilt.android.AndroidEntryPoint
import timber.log.Timber
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.inject.Inject

/**
 * HCE service that responds to a tap from the school printer's NFC reader
 * (the Raspberry Pi tap-box). Emits a signed payload identifying the student.
 *
 * Wire format (UTF-8): `<student_id>\t<watch_session_id>\t<nonce>\t<ts_ms>\t<hmac_hex>`
 * where `hmac_hex` = HMAC-SHA256(WATCH_HCE_SECRET,
 *                                "${student_id}|${session_id}|${nonce}|${ts_ms}").
 *
 * `ts_ms` is the watch's `System.currentTimeMillis()` at sign time. The server
 * rejects payloads older than 60s so a captured tap can't be replayed long
 * after the student has walked away from the printer.
 *
 * The Pi tap-box parses this and POSTs it to /api/v1/print/pair, where the
 * server re-computes the HMAC and creates a 60s pairing the watch can poll.
 */
@AndroidEntryPoint
class KobePrintHceService : HostApduService() {

    @Inject lateinit var prefs: PreferencesManager

    private val rng = SecureRandom()

    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        if (commandApdu == null) return SW_UNKNOWN

        // Hilt may not have injected `prefs` yet if the OS instantiates this
        // service before Application.onCreate finishes. Bail out gracefully.
        if (!::prefs.isInitialized) {
            Timber.w("HCE invoked before Hilt injection; ignoring tap")
            return SW_FILE_NOT_FOUND
        }

        // We expect a SELECT AID command first.
        if (isSelectAid(commandApdu)) {
            val payload = buildPayload() ?: return SW_FILE_NOT_FOUND
            val response = payload.toByteArray(Charsets.UTF_8) + SW_OK
            Timber.d("HCE responded to SELECT with %d bytes", response.size)
            return response
        }

        Timber.w("HCE received non-SELECT APDU (%d bytes), ignoring", commandApdu.size)
        return SW_INS_NOT_SUPPORTED
    }

    override fun onDeactivated(reason: Int) {
        Timber.d("HCE deactivated, reason=%d", reason)
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private fun buildPayload(): String? {
        // Refuse to emit anything if the APK was built without the school's
        // real WATCH_HCE_SECRET — otherwise a release APK would happily sign
        // payloads with the well-known dev key.
        if (BuildConfig.WATCH_HCE_SECRET == DEV_WATCH_HCE_SECRET && !BuildConfig.DEBUG) {
            Timber.e("HCE secret is the dev default in a non-debug build; refusing to emit")
            return null
        }
        val studentId = prefs.getStudentId() ?: return null
        // We use the device id as a stable per-watch session id. In a stricter
        // design this would rotate per login.
        val sessionId = prefs.getDeviceId()
        val nonce = newNonceHex()
        val tsMs = System.currentTimeMillis()
        val msg = "$studentId|$sessionId|$nonce|$tsMs"
        val sig = hmacSha256Hex(BuildConfig.WATCH_HCE_SECRET, msg)
        return "$studentId\t$sessionId\t$nonce\t$tsMs\t$sig"
    }

    private fun newNonceHex(): String {
        val bytes = ByteArray(8)
        rng.nextBytes(bytes)
        return bytes.toHex()
    }

    private fun hmacSha256Hex(key: String, msg: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(msg.toByteArray(Charsets.UTF_8)).toHex()
    }

    private fun ByteArray.toHex(): String =
        joinToString("") { "%02x".format(it) }

    private fun isSelectAid(apdu: ByteArray): Boolean {
        // ISO-7816 SELECT: CLA=00 INS=A4 P1=04 P2=00, then Lc + AID.
        if (apdu.size < 5) return false
        if (apdu[0] != 0x00.toByte()) return false
        if (apdu[1] != 0xA4.toByte()) return false
        if (apdu[2] != 0x04.toByte()) return false
        return true
    }

    companion object {
        private val SW_OK = byteArrayOf(0x90.toByte(), 0x00.toByte())
        private val SW_FILE_NOT_FOUND = byteArrayOf(0x6A.toByte(), 0x82.toByte())
        private val SW_INS_NOT_SUPPORTED = byteArrayOf(0x6D.toByte(), 0x00.toByte())
        private val SW_UNKNOWN = byteArrayOf(0x6F.toByte(), 0x00.toByte())
        // Mirror of the gradle default in app/build.gradle.kts. A release APK
        // built without -PWATCH_HCE_SECRET= will carry this value and must
        // refuse to emit signed payloads.
        private const val DEV_WATCH_HCE_SECRET = "dev-watch-hce-secret"
    }
}

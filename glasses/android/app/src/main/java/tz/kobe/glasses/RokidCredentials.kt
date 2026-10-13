package tz.kobe.glasses

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Provision once. The developer secret and licence never cross the WebView bridge. */
object RokidCredentials {
    private const val ALIAS = "kobe.rokid.provisioning"
    private fun prefs(context: Context) = context.getSharedPreferences("rokid-provisioning", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun load(context: Context): Pair<ByteArray, String>? = try {
        val encoded = prefs(context).getString("credentials", null)
        if (encoded == null) null else {
            val data = JSONObject(encoded)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(data.getString("iv"), Base64.NO_WRAP)))
            val plain = JSONObject(String(cipher.doFinal(Base64.decode(data.getString("data"), Base64.NO_WRAP)), Charsets.UTF_8))
            Pair(Base64.decode(plain.getString("licence"), Base64.NO_WRAP), plain.getString("secret"))
        }
    } catch (_: Exception) { null }
    fun save(context: Context, licence: ByteArray, secret: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val plain = JSONObject().put("licence", Base64.encodeToString(licence, Base64.NO_WRAP)).put("secret", secret)
        val encoded = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(plain.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
        check(prefs(context).edit().putString("credentials", encoded.toString()).putBoolean("automatic", true).commit())
    }
    fun automatic(context: Context) = prefs(context).getBoolean("automatic", false) && load(context) != null
    fun enable(context: Context, enabled: Boolean) { prefs(context).edit().putBoolean("automatic", enabled).apply() }
    fun forget(context: Context) { prefs(context).edit().clear().commit() }
}

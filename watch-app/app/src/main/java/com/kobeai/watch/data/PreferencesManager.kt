package com.kobeai.watch.data

import android.content.Context
import android.content.SharedPreferences
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.kobeai.watch.BuildConfig
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import javax.inject.Inject
import javax.inject.Singleton

internal val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "kobeai_prefs")

@Singleton
class PreferencesManager @Inject constructor(
    @ApplicationContext private val context: Context
) {

    private val dataStore = context.dataStore

    // AES256_GCM-backed prefs file for credentials and any stable identifier
    // that lets the API server recognise this watch. Kept separate from the
    // plain DataStore so a casual file dump (or backup) doesn't yield tokens.
    private val secretPrefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "kobeai_secrets",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    companion object {
        private val IS_LOGGED_IN = booleanPreferencesKey("is_logged_in")
        private val STUDENT_NAME = stringPreferencesKey("student_name")
        private val WALLET_BALANCE = intPreferencesKey("wallet_balance")
        private val SERVER_URL = stringPreferencesKey("server_url")
        private val AUDIO_ENABLED = booleanPreferencesKey("audio_enabled")
        private val KEYBOARD_ENABLED = booleanPreferencesKey("keyboard_enabled")
        // Parent-controlled ad opt-out, mirrored from /v1/watch/settings on
        // launch/resume. Defaults true so the UI matches the existing
        // behaviour for watches that haven't synced yet.
        private val ADS_ENABLED = booleanPreferencesKey("ads_enabled")
        private val SETUP_COMPLETED = booleanPreferencesKey("setup_completed")

        // Keys living in EncryptedSharedPreferences.
        private const val SK_AUTH_TOKEN = "auth_token"
        private const val SK_STUDENT_ID = "student_id"
        private const val SK_DEVICE_ID = "device_id"
    }

    val isLoggedIn: Flow<Boolean> = dataStore.data.map { it[IS_LOGGED_IN] ?: false }
    val studentName: Flow<String> = dataStore.data.map { it[STUDENT_NAME] ?: "" }
    val walletBalance: Flow<Int> = dataStore.data.map { it[WALLET_BALANCE] ?: 0 }
    val audioEnabled: Flow<Boolean> = dataStore.data.map { it[AUDIO_ENABLED] ?: true }
    val keyboardEnabled: Flow<Boolean> = dataStore.data.map { it[KEYBOARD_ENABLED] ?: true }
    val adsEnabled: Flow<Boolean> = dataStore.data.map { it[ADS_ENABLED] ?: true }
    val setupCompleted: Flow<Boolean> = dataStore.data.map { it[SETUP_COMPLETED] ?: false }

    fun getAuthToken(): String? = secretPrefs.getString(SK_AUTH_TOKEN, null)

    fun getStudentId(): String? = secretPrefs.getString(SK_STUDENT_ID, null)

    fun getServerUrl(): String = runBlocking {
        dataStore.data.map { it[SERVER_URL] }.firstOrNull() ?: BuildConfig.DEFAULT_API_BASE
    }

    fun getDeviceId(): String {
        val existing = secretPrefs.getString(SK_DEVICE_ID, null)
        if (existing != null) return existing
        val id = java.util.UUID.randomUUID().toString()
        secretPrefs.edit().putString(SK_DEVICE_ID, id).apply()
        return id
    }

    suspend fun setLoggedIn(value: Boolean) {
        dataStore.edit { it[IS_LOGGED_IN] = value }
    }

    suspend fun setAuthToken(token: String) {
        secretPrefs.edit().putString(SK_AUTH_TOKEN, token).apply()
    }

    suspend fun setStudentInfo(id: String, name: String) {
        secretPrefs.edit().putString(SK_STUDENT_ID, id).apply()
        dataStore.edit { it[STUDENT_NAME] = name }
    }

    suspend fun setWalletBalance(balance: Int) {
        dataStore.edit { it[WALLET_BALANCE] = balance }
    }

    suspend fun setServerUrl(url: String) {
        dataStore.edit { it[SERVER_URL] = url }
    }

    suspend fun setAudioEnabled(value: Boolean) {
        dataStore.edit { it[AUDIO_ENABLED] = value }
    }

    suspend fun setKeyboardEnabled(value: Boolean) {
        dataStore.edit { it[KEYBOARD_ENABLED] = value }
    }

    suspend fun setAdsEnabled(value: Boolean) {
        dataStore.edit { it[ADS_ENABLED] = value }
    }

    suspend fun setSetupCompleted(value: Boolean) {
        dataStore.edit { it[SETUP_COMPLETED] = value }
    }
}


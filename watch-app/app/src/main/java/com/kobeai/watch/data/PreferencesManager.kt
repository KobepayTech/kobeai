package com.kobeai.watch.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.kobeai.watch.BuildConfig
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
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

    companion object {
        private val IS_LOGGED_IN = booleanPreferencesKey("is_logged_in")
        private val AUTH_TOKEN = stringPreferencesKey("auth_token")
        private val STUDENT_ID = stringPreferencesKey("student_id")
        private val STUDENT_NAME = stringPreferencesKey("student_name")
        private val WALLET_BALANCE = intPreferencesKey("wallet_balance")
        private val SERVER_URL = stringPreferencesKey("server_url")
        private val DEVICE_ID = stringPreferencesKey("device_id")
    }

    val isLoggedIn: Flow<Boolean> = dataStore.data.map { it[IS_LOGGED_IN] ?: false }
    val studentName: Flow<String> = dataStore.data.map { it[STUDENT_NAME] ?: "" }
    val walletBalance: Flow<Int> = dataStore.data.map { it[WALLET_BALANCE] ?: 0 }

    fun getAuthToken(): String? = runBlocking {
        dataStore.data.map { it[AUTH_TOKEN] }.first()
    }

    fun getStudentId(): String? = runBlocking {
        dataStore.data.map { it[STUDENT_ID] }.first()
    }

    fun getServerUrl(): String = runBlocking {
        dataStore.data.map { it[SERVER_URL] }.first() ?: BuildConfig.DEFAULT_API_BASE
    }

    fun getDeviceId(): String = runBlocking {
        dataStore.data.map { it[DEVICE_ID] }.first() ?: run {
            val id = java.util.UUID.randomUUID().toString()
            setDeviceId(id)
            id
        }
    }

    suspend fun setLoggedIn(value: Boolean) {
        dataStore.edit { it[IS_LOGGED_IN] = value }
    }

    suspend fun setAuthToken(token: String) {
        dataStore.edit { it[AUTH_TOKEN] = token }
    }

    suspend fun setStudentInfo(id: String, name: String) {
        dataStore.edit {
            it[STUDENT_ID] = id
            it[STUDENT_NAME] = name
        }
    }

    suspend fun setWalletBalance(balance: Int) {
        dataStore.edit { it[WALLET_BALANCE] = balance }
    }

    suspend fun setServerUrl(url: String) {
        dataStore.edit { it[SERVER_URL] = url }
    }

    private fun setDeviceId(id: String) = runBlocking {
        dataStore.edit { it[DEVICE_ID] = id }
    }
}

package tz.kobe.glasses

import android.content.Context

/** Device selection only; no developer credential is required or migrated. Backups are disabled. */
object MoYoungPairing {
    private fun prefs(context: Context) = context.getSharedPreferences("moyoung-pairing", Context.MODE_PRIVATE)
    fun address(context: Context): String? = prefs(context).getString("address", null)
    fun save(context: Context, address: String) {
        check(prefs(context).edit().putString("address", address).putBoolean("automatic", true).commit())
    }
    fun automatic(context: Context) = prefs(context).getBoolean("automatic", false) && address(context) != null
    fun enable(context: Context, enabled: Boolean) { prefs(context).edit().putBoolean("automatic", enabled).apply() }
    fun forget(context: Context) { check(prefs(context).edit().clear().commit()) }
}

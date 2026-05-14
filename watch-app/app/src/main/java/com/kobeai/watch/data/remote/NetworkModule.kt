package com.kobeai.watch.data.remote

import com.google.gson.GsonBuilder
import com.kobeai.watch.BuildConfig
import com.kobeai.watch.data.PreferencesManager
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.CertificatePinner
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(prefsManager: PreferencesManager): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level =
                if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
                else HttpLoggingInterceptor.Level.NONE
        }

        val authInterceptor = Interceptor { chain ->
            val token = prefsManager.getAuthToken()
            val request = if (!token.isNullOrEmpty()) {
                chain.request().newBuilder()
                    .addHeader("Authorization", "Bearer $token")
                    .build()
            } else {
                chain.request()
            }
            chain.proceed(request)
        }

        // Belt-and-braces enforcement of HTTPS in addition to
        // network_security_config.xml. If something programmatically replaces
        // the base URL with http:// (e.g. parent-app dev override), we still
        // refuse to make the request rather than leak a bearer token.
        val httpsOnlyInterceptor = Interceptor { chain ->
            val req = chain.request()
            if (!BuildConfig.DEBUG && !req.url.isHttps) {
                throw java.io.IOException("refusing cleartext request to ${req.url}")
            }
            chain.proceed(req)
        }

        val builder = OkHttpClient.Builder()
            .addInterceptor(logging)
            .addInterceptor(authInterceptor)
            .addInterceptor(httpsOnlyInterceptor)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)

        // Optional SPKI pin for the school's API. Operators that want
        // MITM-resistance ship the APK with -PKOBEAI_API_PIN=sha256/...; if
        // unset we fall back to system-CA trust (which network_security_config
        // restricts to non-user CAs in release).
        val pin = BuildConfig.KOBEAI_API_PIN
        if (pin.isNotBlank()) {
            val host = prefsManager.getServerUrl().toHttpUrlOrNull()?.host
            if (host != null) {
                builder.certificatePinner(
                    CertificatePinner.Builder().add(host, pin).build()
                )
            }
        }
        return builder.build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(client: OkHttpClient, prefsManager: PreferencesManager): Retrofit =
        Retrofit.Builder()
            .baseUrl(prefsManager.getServerUrl())
            .client(client)
            .addConverterFactory(
                GsonConverterFactory.create(GsonBuilder().setLenient().create())
            )
            .build()

    @Provides
    @Singleton
    fun provideApiService(retrofit: Retrofit): ApiService =
        retrofit.create(ApiService::class.java)

    @Provides
    @Singleton
    fun providePrintApiService(retrofit: Retrofit): PrintApiService =
        retrofit.create(PrintApiService::class.java)
}

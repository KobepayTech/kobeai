plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("kotlin-kapt")
    id("com.google.dagger.hilt.android")
}

android {
    namespace = "com.kobeai.watch"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.kobeai.watch"
        minSdk = 30
        targetSdk = 34
        versionCode = 5
        versionName = "5.1.0"

        // Default API base URL. Override in local.properties or pass at build time:
        //   ./gradlew assembleDebug -PKOBEAI_API_BASE=https://your-app.replit.app/
        val apiBase = (project.findProperty("KOBEAI_API_BASE") as String?)
            ?: "https://kobeai.replit.app/"
        buildConfigField("String", "DEFAULT_API_BASE", "\"$apiBase\"")

        // Shared HMAC secret used to sign the HCE payload sent to the school
        // tap-box. Must match WATCH_HCE_SECRET on the API server. Override at
        // build time:
        //   ./gradlew assembleRelease -PWATCH_HCE_SECRET=<random-32-bytes-hex>
        val hceSecret = (project.findProperty("WATCH_HCE_SECRET") as String?)
            ?: "dev-watch-hce-secret"
        buildConfigField("String", "WATCH_HCE_SECRET", "\"$hceSecret\"")
    }

    signingConfigs {
        create("release") {
            storeFile = file("keystore/kobeai-release-key.jks")
            storePassword = "kobeai2024"
            keyAlias = "kobeai"
            keyPassword = "kobeai2024"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Uncomment after creating the keystore in app/keystore/
            // signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.4"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.wear:wear:1.3.0")
    implementation("androidx.wear:wear-input:1.2.0-alpha02")

    implementation("androidx.wear.compose:compose-material:1.3.0")
    implementation("androidx.wear.compose:compose-foundation:1.3.0")
    implementation("androidx.wear.compose:compose-navigation:1.3.0")

    implementation(platform("androidx.compose:compose-bom:2023.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.runtime:runtime-livedata")
    implementation("androidx.activity:activity-compose:1.8.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")

    implementation("androidx.navigation:navigation-compose:2.7.5")

    implementation("com.google.dagger:hilt-android:2.48")
    kapt("com.google.dagger:hilt-compiler:2.48")
    implementation("androidx.hilt:hilt-navigation-compose:1.1.0")
    implementation("androidx.hilt:hilt-work:1.1.0")
    kapt("androidx.hilt:hilt-compiler:1.1.0")

    implementation("androidx.work:work-runtime-ktx:2.9.0")

    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    implementation("com.google.code.gson:gson:2.10.1")

    implementation("androidx.room:room-runtime:2.6.0")
    implementation("androidx.room:room-ktx:2.6.0")
    kapt("androidx.room:room-compiler:2.6.0")

    implementation("androidx.datastore:datastore-preferences:1.0.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    implementation("com.jakewharton.timber:timber:5.0.1")
}

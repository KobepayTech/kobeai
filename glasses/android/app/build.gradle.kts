plugins { id("com.android.application") }

android {
    namespace = "tz.kobe.glasses"
    compileSdk = 36
    defaultConfig {
        applicationId = "tz.kobe.glasses"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
    flavorDimensions += "hardware"
    productFlavors {
        create("companion") { dimension = "hardware" }
        create("rayneo") { dimension = "hardware"; applicationIdSuffix = ".rayneo" }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // Bundle our own Lens UI. Remote pages never receive the hardware bridge.
    sourceSets["main"].assets.srcDir("../../../artifacts/teacher-lens/dist/public")
    buildTypes { release { isMinifyEnabled = false } }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("io.github.hkust-spark:xgglass-core:0.3.0")
    "companionImplementation"(files("libs/moyoung_glasses_sdk_0.0.7_20260624.aar"))
    "companionImplementation"(files("libs/jl_audio_decode_V2.1.0_20012-release.aar", "libs/jl_bt_ota_V1.10.0_10932-release.aar"))
    "companionImplementation"("com.google.protobuf:protobuf-java:4.29.3")
    "companionImplementation"("com.squareup.okhttp3:okhttp:4.12.0")
    "companionImplementation"("com.google.code.gson:gson:2.9.0")
    "companionImplementation"("io.reactivex.rxjava3:rxjava:3.1.8")
    "companionImplementation"("io.reactivex.rxjava3:rxandroid:3.0.2")
    "companionImplementation"("org.nanohttpd:nanohttpd:2.3.1")
    "rayneoImplementation"("io.github.hkust-spark:xgglass-device-rayneo-runtime:0.3.0")
}

tasks.register("verifyLensAssets") {
    doLast { check(file("../../../artifacts/teacher-lens/dist/public/index.html").isFile) {
        "Build Teacher Lens first: pnpm --filter @workspace/teacher-lens build"
    } }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn("verifyLensAssets") }
tasks.matching { it.name == "preCompanionDebugBuild" || it.name == "preCompanionReleaseBuild" }.configureEach {
    doFirst {
        listOf("moyoung_glasses_sdk_0.0.7_20260624.aar", "jl_audio_decode_V2.1.0_20012-release.aar", "jl_bt_ota_V1.10.0_10932-release.aar").forEach { name ->
            check(file("libs/$name").isFile) { "Fetch the pinned MoYoung SDK: python3 ../scripts/fetch_moyoung.py" }
        }
    }
}

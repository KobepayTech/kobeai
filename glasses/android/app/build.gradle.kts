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
    "companionImplementation"("io.github.hkust-spark:xgglass-device-rokid:0.3.0")
    // HeyCyan, development only. Supply the AAR yourself at
    // app/libs/heycyan-sdk.aar; nothing in this repository fetches it, and the
    // release guard below refuses to build a distributable APK with it present.
    "companionImplementation"(fileTree("libs") { include("heycyan-sdk.aar") })
    "companionImplementation"("androidx.localbroadcastmanager:localbroadcastmanager:1.1.0")
    "companionImplementation"("com.google.code.gson:gson:2.14.0")
    "companionImplementation"("org.greenrobot:eventbus:3.2.0")
    "rayneoImplementation"("io.github.hkust-spark:xgglass-device-rayneo-runtime:0.3.0")
}

// A release APK must not carry the unlicensed HeyCyan SDK.
//
// "We'll deal with the licence once it works" is a reasonable way to develop,
// and it only stays reasonable if shipping it is hard rather than easy. A debug
// build evaluates the hardware; a release build fails while the AAR is there,
// and says what to do about it. This is a control, not a comment — the last
// time this binary was in the tree, the only guard was a comment in CI and it
// was compiled into every Rokid build.
tasks.matching { it.name == "preCompanionReleaseBuild" }.configureEach {
    doFirst {
        check(!file("libs/heycyan-sdk.aar").isFile) {
            "app/libs/heycyan-sdk.aar is present: HeyCyan is a development-only " +
                "provider and must not be distributed. Remove the AAR to build a " +
                "release, or obtain a distribution licence from HeyCyan first."
        }
    }
}

tasks.register("verifyLensAssets") {
    doLast { check(file("../../../artifacts/teacher-lens/dist/public/index.html").isFile) {
        "Build Teacher Lens first: pnpm --filter @workspace/teacher-lens build"
    } }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn("verifyLensAssets") }

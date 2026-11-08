plugins { id("com.android.application") }

// The K9 student tablet: the web app in artifacts/student-tablet wrapped in a
// WebView that can reach the camera and microphone.
//
// Deliberately far smaller than :app. A student's tablet has no glasses, no
// Bluetooth and no native bridge — the session they sign in with *is* their
// identity (docs/K9_ATTRIBUTION_GATES.md), so nothing here needs to recognise
// anybody.
android {
    namespace = "tz.kobe.student"
    compileSdk = 36
    defaultConfig {
        applicationId = "tz.kobe.student"
        resValue("string", "app_name", "K9")
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
    buildFeatures { resValues = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // The built tablet is the app's assets. Nothing is fetched at runtime, so a
    // school with no internet still has a working tablet.
    sourceSets["main"].assets.srcDir("../../../artifacts/student-tablet/dist/public")
    buildTypes { release { isMinifyEnabled = false } }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
}

tasks.register("verifyStudentAssets") {
    doLast {
        check(file("../../../artifacts/student-tablet/dist/public/index.html").isFile) {
            "Build the tablet first: pnpm --filter @workspace/student-tablet build"
        }
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn("verifyStudentAssets") }

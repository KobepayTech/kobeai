buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        // Match the Kotlin metadata shipped by xg.glass 0.3.0.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.0")
    }
}

plugins { id("com.android.application") version "9.2.1" apply false }

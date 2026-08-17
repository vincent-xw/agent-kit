plugins {
    id("com.android.application")
    id("kotlin-android")
}

android {
    namespace = "com.agentkit.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.agentkit.companion"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.10.0")
    // NanoHTTPD — 轻量 HTTP 服务器，单文件无依赖
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
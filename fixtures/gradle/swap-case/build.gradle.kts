import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    `default-convention`
    alias(libs.plugins.kotlin.jvm)
    // Deliberate issue for Sonar to find: the full ID of a core plugin instead of its short name.
    id("org.gradle.jacoco")
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
    }
}

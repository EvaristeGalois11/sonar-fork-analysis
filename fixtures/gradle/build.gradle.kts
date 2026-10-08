plugins {
    alias(libs.plugins.sonar)
}

sonar {
    properties {
        // Indexes files outside the source sets too, such as the Containerfile and the Helm chart.
        property("sonar.gradle.scanAll", true)
    }
}

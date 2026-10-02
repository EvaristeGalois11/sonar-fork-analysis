// Fixtures Sonar sets this while analysing on the fork path, where nothing may run the analysed build:
// the wrapper is not the only way in, e.g. the Gradle Tooling API.
System.getenv("SONAR_FORK_ANALYSIS_TRAP")?.let {
    java.io.File(it).appendText("settings.gradle.kts evaluated\n")
    throw GradleException("The fork path ran the analysed build")
}

rootProject.name = "fixture-gradle"
include("fizzbuzz", "swap-case", "composite")

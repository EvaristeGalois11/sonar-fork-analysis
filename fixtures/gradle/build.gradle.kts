plugins {
    alias(libs.plugins.sonar)
}

sonar {
    properties {
        // The aggregated report is not in a default location, so the build has to declare it.
        property(
            "sonar.coverage.jacoco.xmlReportPaths",
            "${projectDir}/report-aggregate/build/reports/jacoco/testCodeCoverageReport/testCodeCoverageReport.xml"
        )
    }
}

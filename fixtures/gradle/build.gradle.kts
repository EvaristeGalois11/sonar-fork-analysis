plugins {
    alias(libs.plugins.sonar)
}

sonar {
    properties {
        // The aggregated report is not in a default location, so the build has to declare it, as an
        // aggregate: read once for the whole project, where xmlReportPaths would be inherited by
        // every module, the root included, which has no classes to match it against.
        property(
            "sonar.coverage.jacoco.aggregateXmlReportPaths",
            "${projectDir}/report-aggregate/build/reports/jacoco/testCodeCoverageReport/testCodeCoverageReport.xml"
        )
    }
}

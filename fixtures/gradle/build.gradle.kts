plugins {
    alias(libs.plugins.sonar)
}

// Dependabot doesn't update gradle/verification-metadata.xml.
sonar {
    properties {
        property("sonar.issue.ignore.multicriteria", "verification")
        property("sonar.issue.ignore.multicriteria.verification.ruleKey", "kotlin:S6474")
        property("sonar.issue.ignore.multicriteria.verification.resourceKey", "**/*")
    }
}

plugins {
    base
    `jacoco-report-aggregation`
}

repositories {
    mavenCentral()
}

dependencies {
    jacocoAggregation(project(":fizzbuzz"))
    jacocoAggregation(project(":swap-case"))
    jacocoAggregation(project(":composite"))
}

reporting {
    reports {
        val testCodeCoverageReport by creating(JacocoCoverageReport::class) {
            testSuiteName = "test"
        }
    }
}

tasks.check {
    dependsOn(tasks.named<JacocoReport>("testCodeCoverageReport"))
}

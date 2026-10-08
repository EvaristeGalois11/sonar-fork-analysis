package org.example.sonarforkanalysis

class SwapCase {
    fun swapCase(str: String): String {
        // Deliberate: an unused variable for Sonar to report.
        val length = str.length
        return str.map { if (it.isLowerCase()) it.uppercaseChar() else it.lowercaseChar() }.joinToString("")
    }
}

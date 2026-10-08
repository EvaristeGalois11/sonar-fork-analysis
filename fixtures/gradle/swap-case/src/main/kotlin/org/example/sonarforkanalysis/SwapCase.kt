package org.example.sonarforkanalysis

class SwapCase {
    fun swapCase(str: String): String {
        // Deliberate: an unused variable for Sonar to report.
        val length = str.length
        // Deliberate: get instead of [it]. Sonar only finds it when the build's libraries reach the analysis.
        val chars = str.toList()
        return chars.indices.map { swap(chars.get(it)) }.joinToString("")
    }

    private fun swap(c: Char) = if (c.isLowerCase()) c.uppercaseChar() else c.lowercaseChar()
}

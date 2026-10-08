package org.example.sonarforkanalysis

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource

class SwapCaseTest {
    private val swapCase = SwapCase()

    @ParameterizedTest
    @CsvSource("string, STRING", "String, sTRING", "STRINg, strinG", "STRING, string", "'', ''")
    fun swapCase(str: String, expected: String) {
        assertEquals(expected, swapCase.swapCase(str))
    }
}

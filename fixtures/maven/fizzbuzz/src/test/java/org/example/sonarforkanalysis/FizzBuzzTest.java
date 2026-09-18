package org.example.sonarforkanalysis;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class FizzBuzzTest {
  private final FizzBuzz fizzBuzz = new FizzBuzz();

  @MethodSource
  @ParameterizedTest
  void fizzBuzzTest(int value, String expected) {
    var result = fizzBuzz.fizzBuzz(value);
    assertEquals(expected, result);
  }

  public static List<Arguments> fizzBuzzTest() {
    return List.of(
        Arguments.of(0, "FizzBuzz"),
        Arguments.of(1, ""),
        Arguments.of(3, "Fizz"),
        Arguments.of(5, "Buzz"),
        Arguments.of(9, "Fizz"),
        Arguments.of(10, "Buzz"),
        Arguments.of(15, "FizzBuzz"),
        Arguments.of(19, ""));
  }
}

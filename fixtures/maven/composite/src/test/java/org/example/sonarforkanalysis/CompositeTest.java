package org.example.sonarforkanalysis;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class CompositeTest {
  private final Composite composite = new Composite();

  @MethodSource
  @ParameterizedTest
  void compositeTest(int value, String expected) {
    var result = composite.composite(value);
    assertEquals(expected, result);
  }

  public static List<Arguments> compositeTest() {
    return List.of(
        Arguments.of(0, "fIZZbUZZ"),
        Arguments.of(1, ""),
        Arguments.of(3, "fIZZ"),
        Arguments.of(5, "bUZZ"),
        Arguments.of(9, "fIZZ"),
        Arguments.of(10, "bUZZ"),
        Arguments.of(15, "fIZZbUZZ"),
        Arguments.of(19, ""));
  }
}

package org.example.sonarforkanalysis;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Deliberately faulty tests. Their issues can only be raised when the analysis resolves the JUnit
 * library, so they are what proves that the library jars survived the split. Do not "fix" them.
 */
class SmellyTest {
  private final Smelly smelly = new Smelly();

  @Test
  void noAssertion() {
    smelly.viaLibrary(3);
  }

  @Test
  void swappedArguments() {
    assertEquals(smelly.viaLibrary(3), "Fizz");
  }

  @Test
  void assertTrueEquals() {
    assertTrue(smelly.viaLibrary(3).equals("Fizz"));
  }
}

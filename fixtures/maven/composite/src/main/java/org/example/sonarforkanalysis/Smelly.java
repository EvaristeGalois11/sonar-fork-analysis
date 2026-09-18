package org.example.sonarforkanalysis;

import java.util.Optional;

/**
 * Deliberately faulty class. The issues raised here are asserted by the end-to-end test, so do not
 * "fix" them.
 */
public class Smelly {
  private final FizzBuzz fizzBuzz = new FizzBuzz();
  private int unused;

  public String first(Optional<String> value) {
    return value.get();
  }

  public boolean same(String a, String b) {
    return a == b;
  }

  public String viaLibrary(int n) {
    String s = fizzBuzz.fizzBuzz(n);
    if (s == null) {
      return "never";
    }
    return s;
  }
}
